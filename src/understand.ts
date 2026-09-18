import { truncate } from "./actions.ts";
import { ask, type ChoiceAnswer, type Judge, type NoulAnswer, type Question } from "./judge.ts";
import { describe, type Policy, type PolicyOp } from "./policy.ts";

// Jev's job here is narrow: classify how one new user message changes the policies that already
// exist, plus a few yes/no signals. It never writes a policy. The plugin turns confident answers
// into ops; UNKNOWN or low confidence changes nothing. One request per message, all questions at
// once (Jev's latency is flat in the number of questions).

export const DELTA_CRITERIA = {
	KEEP: "The message leaves this policy as it is",
	LIFT: "The message removes this policy entirely",
	NARROW: "The message keeps the policy but makes it cover less",
	EXCEPTION: "The message keeps the policy but allows one specific thing it covers",
	REPLACE: "The message replaces this policy with a different rule",
	UNKNOWN: "The message does not say clearly how this policy changes",
} as const;

export type DeltaKind = keyof typeof DELTA_CRITERIA;

// Built-in prohibitions are asked two ways in the same request (latency is flat in the number of questions).
// The yes/no statement is precise but misses paraphrases ("look but don't touch": 0.57); the forbidden/allowed/unclear
// choice catches them but bleeds across kinds (read-only → "also no tests, deps, push"). A/B on 108 labelled
// (message, kind) pairs: statement alone 13/17 recall, 0 false adds; choice alone 17/17, 27 false adds;
// statement ≥ 0.8, or statement ≥ 0.5 with choice ≥ 0.9: 17/17. Its only 2 false adds were cross-talk from a
// message the rules had already parsed, which the caller excludes.
const BUILTIN_DENIES = {
	read_only: { text: "The user explicitly forbids the assistant from modifying any files (read-only, review only, just look, no edits).", what: "modify files", action: "modify", resource: "*" },
	no_tests: { text: "The user explicitly forbids the assistant from modifying, deleting, disabling or skipping tests.", what: "modify, delete, disable or skip tests", action: "modify", resource: "tests" },
	no_deps: { text: "The user explicitly forbids the assistant from adding or installing new dependencies or packages.", what: "add or install new dependencies or packages", action: "install_deps", resource: "*" },
	no_push: { text: "The user explicitly forbids the assistant from pushing to a remote (git push).", what: "push to a remote (git push)", action: "git_push", resource: "*" },
} as const;

function mayQuestion(what: string): Question {
	return {
		type: "choice",
		instructions: `According to new_user_message, may the assistant ${what}?`,
		criteria: { forbidden: `The user does not want the assistant to ${what}`, allowed: "The user wants or allows it", unclear: "The message does not say, or cannot tell" },
	};
}

// Asking about the user's intent beats a policy taxonomy for lifts (Jev lab: 71% → 93%, confident answers 100% right).
export const GO_AHEAD: Question = {
	type: "choice",
	instructions: "Is new_user_message the user's go-ahead to start making the changes?",
	criteria: {
		go_ahead: "Yes: the user is telling the assistant to proceed with changes",
		not_yet: "No: the user still wants no changes, or only some",
		unrelated: "The message is about something else",
		unclear: "Cannot tell",
	},
};

export const THRESHOLDS = {
	/** A delta choice must have this probability and confidence to be applied. */
	delta: { p: 0.9, confidence: 0.8 },
	/** Add a built-in restriction when statement ≥ add, or statement ≥ addWeak and choice ≥ addChoice. */
	add: 0.8,
	addWeak: 0.5,
	addChoice: 0.9,
	/** P(go_ahead) and confidence to lift read-only. */
	goAhead: { p: 0.9, confidence: 0.8 },
	temporary: 0.8,
	newTask: 0.8,
	/** A rule-made custom prohibition below this is not a real prohibition. */
	reject: 0.2,
};

export interface Understanding {
	ops: PolicyOp[];
	/** Every delta Jev returned, for logs and the benchmark. */
	deltas: Record<string, { kind: string; p: number; confidence: number; applied: boolean }>;
	signals: Record<string, number>;
	ms: number;
	error?: string;
}

export interface UnderstandInput {
	message: string;
	at: number;
	/** Policies active before this message (rules for this message already applied separately). */
	before: Policy[];
	/** Ids the rules already changed for this message: Jev never overrides those. */
	touchedByRules: Set<string>;
	/** Policies the rules just created from this message. */
	createdByRules: Policy[];
	hasGoalScoped: boolean;
	/** Explicit paths in the message (rules-extracted): the resource for a confident EXCEPTION/NARROW delta. */
	mentionedPaths: string[];
}

export async function understand(judge: Judge | undefined, input: UnderstandInput, timeoutMs: number): Promise<Understanding> {
	const empty: Understanding = { ops: [], deltas: {}, signals: {}, ms: 0 };
	if (!judge || !input.message.trim()) return empty;
	const questions: Record<string, Question> = {};

	const existing = input.before.filter((p) => !input.touchedByRules.has(p.id)).slice(-8);
	for (const p of existing) {
		questions[`delta_${p.id}`] = {
			type: "choice",
			instructions: `How does new_user_message change policy ${p.id}: "${truncate(p.sourceQuote, 160)}" (${describe(p)})?`,
			criteria: { ...DELTA_CRITERIA },
		};
	}
	const activeKeys = new Set(input.before.map((p) => `${p.effect}|${p.action}|${p.resource}`));
	// Only for messages the rules found no restriction in: otherwise Jev's extra answers were cross-talk.
	const rulesRestricted = input.createdByRules.some((p) => p.effect !== "ALLOW" && p.action !== "custom");
	if (!rulesRestricted) {
		for (const [name, d] of Object.entries(BUILTIN_DENIES)) {
			if (activeKeys.has(`DENY|${d.action}|${d.resource}`)) continue;
			questions[`set_${name}`] = { type: "noul", instructions: d.text };
			questions[`may_${name}`] = mayQuestion(d.what);
		}
	}
	const readOnly = existing.filter((p) => p.effect === "DENY" && p.action === "modify" && p.resource === "*");
	if (readOnly.length) questions.go_ahead = GO_AHEAD;
	questions.new_prohibition = { type: "noul", instructions: "new_user_message forbids the assistant from doing something." };
	questions.new_permission = { type: "noul", instructions: "new_user_message gives the assistant permission to do something it was not allowed to do." };
	if (input.createdByRules.some((p) => p.effect === "ALLOW" && p.scope === "session")) {
		questions.temporary = { type: "noul", instructions: "The permission in new_user_message is only for a single use or the current step (for example 'this time', 'just once')." };
	}
	if (input.hasGoalScoped) questions.new_task = { type: "noul", instructions: "new_user_message starts a new, unrelated task instead of continuing the current one." };
	for (const p of input.createdByRules.filter((c) => c.action === "custom")) {
		questions[`real_${p.id}`] = {
			type: "noul",
			instructions: `The sentence "${truncate(p.resource, 200)}" forbids the assistant from taking some action (a real prohibition, not advice like "don't forget" or reassurance like "don't worry").`,
		};
	}

	const state = {
		new_user_message: truncate(input.message, 3000),
		policies_before_message: existing.map((p) => ({ id: p.id, said: truncate(p.sourceQuote, 200), rule: describe(p) })),
	};
	const { answers, error, ms } = await ask(judge, state, questions, timeoutMs);
	if (!answers) return { ...empty, ms, error };

	const out: Understanding = { ...empty, ms };
	const choiceP = (k: string, option: string) => {
		const a = answers[k] as ChoiceAnswer | undefined;
		return a?.type === "choice" && a.probabilities ? { p: a.probabilities[option] ?? 0, confidence: a.confidence } : undefined;
	};
	const noul = (k: string) => {
		const a = answers[k] as NoulAnswer | undefined;
		return a?.type === "noul" && typeof a.noul === "number" ? a.noul : undefined;
	};
	for (const k of Object.keys(questions)) {
		const v = noul(k);
		if (v !== undefined) out.signals[k] = v;
	}

	for (const p of existing) {
		const a = answers[`delta_${p.id}`] as ChoiceAnswer | undefined;
		if (a?.type !== "choice" || !a.probabilities) continue;
		const prob = a.probabilities[a.choice] ?? 0;
		const confident = prob >= THRESHOLDS.delta.p && a.confidence >= THRESHOLDS.delta.confidence;
		// Jev classifies the change; the resource must come from the message itself. LIFT needs none.
		// EXCEPTION/NARROW apply only when the message names exactly one explicit path the policy covers;
		// otherwise (and for REPLACE) they are logged, not acted on.
		let applied = false;
		if (confident && a.choice === "LIFT") {
			out.ops.push({ op: "supersede", id: p.id, reason: `lifted (jev p=${prob.toFixed(2)}): "${truncate(input.message, 120)}"`, by: "jev" });
			applied = true;
		} else if (
			confident &&
			(a.choice === "EXCEPTION" || a.choice === "NARROW") &&
			p.effect === "DENY" &&
			p.action === "modify" &&
			input.mentionedPaths.length === 1 &&
			// an exception carves out part of the policy; the same resource would be a lift
			input.mentionedPaths[0] !== p.resource &&
			// the rules already read a permission in this message: its scope ("just this once") wins
			!input.createdByRules.some((c) => c.effect === "ALLOW")
		) {
			out.ops.push({
				op: "add",
				spec: { effect: "ALLOW", action: "modify", resource: input.mentionedPaths[0], scope: "session", sourceQuote: truncate(input.message, 300), by: "jev", at: input.at },
			});
			applied = true;
		}
		out.deltas[p.id] = { kind: a.choice, p: prob, confidence: a.confidence, applied };
	}

	// "Go ahead" lifts read-only, unless the rules found a scoped permission in the same message
	// ("you can edit notes.txt only" is not a go-ahead for everything).
	const go = choiceP("go_ahead", "go_ahead");
	if (go) out.signals.go_ahead = go.p;
	if (go && go.p >= THRESHOLDS.goAhead.p && go.confidence >= THRESHOLDS.goAhead.confidence && !input.createdByRules.some((c) => c.effect === "ALLOW")) {
		for (const p of readOnly) {
			if (out.ops.some((o) => o.op === "supersede" && o.id === p.id)) continue;
			out.ops.push({ op: "supersede", id: p.id, reason: `go-ahead (jev p=${go.p.toFixed(2)}): "${truncate(input.message, 120)}"`, by: "jev" });
			if (out.deltas[p.id]) out.deltas[p.id].applied = true;
		}
	}

	for (const [name, d] of Object.entries(BUILTIN_DENIES)) {
		const statement = noul(`set_${name}`) ?? 0;
		const forbidden = choiceP(`may_${name}`, "forbidden")?.p ?? 0;
		if (forbidden) out.signals[`may_${name}`] = forbidden;
		const add = statement >= THRESHOLDS.add || (statement >= THRESHOLDS.addWeak && forbidden >= THRESHOLDS.addChoice);
		if (add && !input.createdByRules.some((p) => p.effect === "DENY" && p.action === d.action && p.resource === d.resource)) {
			out.ops.push({
				op: "add",
				spec: { effect: "DENY", action: d.action, resource: d.resource, scope: "session", sourceQuote: truncate(input.message, 300), by: "jev", at: input.at },
			});
		}
	}
	if ((noul("temporary") ?? 0) >= THRESHOLDS.temporary) {
		for (const p of input.createdByRules) if (p.effect === "ALLOW" && p.scope === "session") out.ops.push({ op: "rescope", id: p.id, scope: "once", by: "jev" });
	}
	if ((noul("new_task") ?? 0) >= THRESHOLDS.newTask) out.ops.unshift({ op: "end", scope: "goal", before: input.at });
	for (const p of input.createdByRules.filter((c) => c.action === "custom")) {
		const v = noul(`real_${p.id}`);
		if (v !== undefined && v < THRESHOLDS.reject) out.ops.push({ op: "supersede", id: p.id, reason: `not a prohibition (jev p=${v.toFixed(2)})`, by: "jev" });
	}
	return out;
}
