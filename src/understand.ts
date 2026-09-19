import { truncate } from "./actions.ts";
import { ask, type ChoiceAnswer, type Judge, type NoulAnswer, type Question } from "./judge.ts";
import { describe, type Policy, type PolicyOp, type PolicySpec } from "./policy.ts";
import { framing } from "./rules.ts";

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

// Built-in prohibitions: one Noul each. Read-only and push use TypeSafe's structured form (question + focus, true/false
// criteria with not_for and examples); tests and deps keep the prose statement, which kept a wider margin (E09).
// Structured read-only alone caught 9/9 paraphrases with no false adds, replacing the statement+choice combination (E06).
// Criteria examples are deliberately not taken from the benchmark or lab sets.
const BUILTIN_DENIES: Record<string, { question: Question; action: "modify" | "install_deps" | "git_push"; resource: string }> = {
	read_only: {
		question: {
			type: "noul",
			instructions: { question: "Does `new_user_message` forbid the assistant from changing any files?", focus: "A ban on all file changes, or a request for review, explanation or a report only." },
			criteria: {
				true: { what: "The user wants files left unchanged for now", examples: ["Just read through it and summarise, no changes.", "只分析一下，先不要修改"] },
				false: {
					what: "Changes are allowed or requested, or nothing is said about them",
					not_for: "A ban on one specific action only, such as pushing, committing or adding packages",
					examples: ["Please clean this up.", "Don't commit yet."],
				},
			},
		},
		action: "modify",
		resource: "*",
	},
	no_tests: {
		question: { type: "noul", instructions: "The user explicitly forbids the assistant from modifying, deleting, disabling or skipping tests." },
		action: "modify",
		resource: "tests",
	},
	no_deps: {
		question: { type: "noul", instructions: "The user explicitly forbids the assistant from adding or installing new dependencies or packages." },
		action: "install_deps",
		resource: "*",
	},
	no_push: {
		question: {
			type: "noul",
			instructions: { question: "Does `new_user_message` forbid the assistant from pushing to a remote repository?" },
			criteria: {
				true: { what: "The user says not to push", examples: ["Keep it local, no pushing.", "先别 push"] },
				false: { what: "No ban on pushing", not_for: "A ban on committing or editing only", examples: ["Push when you're done.", "Don't edit the config."] },
			},
		},
		action: "git_push",
		resource: "*",
	},
};

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

// A "don't …" sentence can be a rule about an operation a tool call performs ("never push", "don't touch .env")
// or guidance about how to write the code ("don't over-engineer", "不要为了架构漂亮重写"). Only the first can be
// enforced at a tool call. Probe on real-session sentences: 18/18 separated, 8/9 guidance confidently (E11).
export const RULE_OR_GUIDANCE = {
	type: "choice",
	instructions: {
		question: "What kind of instruction is `sentence`?",
		focus: "Whether a single tool call (a file write, a shell command, a network request, a git operation) could break it on its own.",
	},
	criteria: {
		action_rule: { what: "Forbids a concrete operation that one tool call could perform", examples: ["Don't drop the users table.", "不要删除 logs 目录"] },
		design_guidance: {
			what: "Guidance about how to design or write the code; judging it needs the code's content, not the operation",
			not_for: "A ban on a specific file, command, service or data",
			examples: ["Prefer small functions.", "不要写得太复杂"],
		},
		unclear: "Cannot tell",
	},
} as const;

// The parser sees "don't push" in "explain why people say never push" and in "write a hook that blocks pushes".
// This asks whether the sentence restricts the assistant at all (E16).
export const DIRECTIVE = {
	type: "choice",
	instructions: {
		question: "Does `new_user_message` restrict what the assistant itself may do?",
		focus: "Who the restriction is for. A restriction on the code, docs or hooks the assistant is asked to write, or on other people, is not a restriction on the assistant.",
	},
	criteria: {
		restricts_assistant: {
			what: "The user tells the assistant not to do this (or to ask first), now or for the rest of the session",
			examples: ["Why is it failing? Don't change the tests though.", "先别提交，我要先看一下。"],
		},
		not_a_rule: {
			what: "No such restriction on the assistant: the message explains or asks about a rule, quotes someone else's rule, describes existing code, specifies behaviour of code or text to write, or gives permission or reassurance",
			not_for: "A real restriction that comes with a question or a task in the same message",
			examples: ["Explain why people say never force push.", "帮我写个 git hook，禁止直接 push 到 main。", "I don't mind if you edit the tests."],
		},
		unclear: "Cannot tell",
	},
} as const;

// A long message with pasted material: is it a task for this assistant (its bans bind) or material to read (a prompt
// for another AI, another agent's report, a log)? Real pastes from the author's sessions: 23/25, and no material was
// taken as a task (E17). Examples are deliberately not from that set.
export const PASTE_KIND = {
	type: "choice",
	instructions: {
		question: "Is `new_user_message` a task the user gives this assistant to carry out, with its constraints?",
		focus: "Whom the long material is for. A prompt written for another AI or reviewer, another agent's report, a log, or a document to look at is material, even when it says 'you' or 'do not'.",
	},
	criteria: {
		task_for_assistant: {
			what: "Instructions for this assistant to follow now: a task, a spec, requirements, constraints",
			examples: ["Refactor the billing module. Constraints: keep the public API, don't touch migrations. Report what changed.", "修一下登录页的样式。要求：只改 css，不要动接口。做完告诉我改了哪些文件。"],
		},
		material: {
			what: "Something for the assistant to read, review or discuss: a report, a prompt meant for another AI, a log, someone else's document or conversation",
			examples: ["Here is the prompt I use for my reviewer bot: You are a strict reviewer. Do not edit code. …", "同事的周报：本周完成了支付重构，没有改数据库……"],
		},
		unclear: "Cannot tell",
	},
} as const;

/**
 * Inside pasted material, a line can still be the user's own ("我的要求：这次别动 package.json"). Real pastes: every line of
 * 13 pasted reports, prompts and logs was told apart except two report lines at 0.91; the user's own lines scored
 * ≥ 0.95 (E17). Examples are not from that set.
 */
export function ownLineQuestion(line: string): Question {
	return {
		type: "choice",
		instructions: {
			question: `Who is this line in \`new_user_message\` from: "${truncate(line, 200)}"?`,
			focus: "The user often pastes material (another AI's report or plan, a prompt written for another AI, a log, a document) and adds their own words around or inside it. Only the user's own words are instructions to this assistant.",
		},
		criteria: {
			user_own: { what: "The user's own instruction to this assistant, added around or inside the pasted material", examples: ["我的要求：这次别动 migrations。", "Note from me: don't deploy anything today."] },
			pasted: { what: "Part of the pasted material: written by someone else, or for someone else", examples: ["You are a strict reviewer. Do not edit code.", "我只核对了代码，没有改文件。"] },
			unclear: "Cannot tell",
		},
	} as unknown as Question;
}

/** Long messages: the start and the end, where the user frames what they pasted. */
function headAndTail(text: string): string {
	return text.length <= 3000 ? text : `${text.slice(0, 2000)}\n…\n${text.slice(-900)}`;
}

export function directiveQuestion(rule: string): Question {
	return { ...DIRECTIVE, instructions: { ...DIRECTIVE.instructions, question: `Does \`new_user_message\` restrict the assistant itself: ${rule}?` } } as unknown as Question;
}

export const THRESHOLDS = {
	/** A delta choice must have this probability and confidence to be applied. */
	delta: { p: 0.9, confidence: 0.8 },
	/** P(yes) to add a built-in restriction. Calibration (E05): 0.7–0.9 → 94% true, ≥ 0.9 → 98%. */
	add: 0.8,
	/** P(go_ahead) and confidence to lift read-only. */
	goAhead: { p: 0.9, confidence: 0.8 },
	/**
	 * Same, for a hold the user meant as temporary ("先别改", "not yet"). Replay of the author's sessions: 改吧 0.77/0.69,
	 * 确认并开始 0.81/0.75, 整理成md 0.89/0.84 are go-aheads; 你打算怎么改 0.57/0.43 and 好改吗 0.03 are not (E17).
	 */
	goAheadHold: { p: 0.75, confidence: 0.65 },
	temporary: 0.8,
	newTask: 0.8,
	/** A rule-made custom prohibition below this is not a real prohibition. */
	reject: 0.2,
	/** P(design_guidance) and confidence to stop treating a sentence as an enforceable ban. */
	guidance: { p: 0.9, confidence: 0.8 },
	/** P(task_for_assistant) and confidence for the bans inside pasted material to count (E17). */
	pastedTask: { p: 0.9, confidence: 0.8 },
	/** P(user_own) and confidence for one line inside pasted material. Report lines reached 0.91/0.87 (E17). */
	ownLine: { p: 0.93, confidence: 0.85 },
	/** P(not_a_rule) and confidence to drop a parsed restriction. E16: not-rules ≥ 0.96, real rules ≤ 0.19. */
	notARule: { p: 0.9, confidence: 0.8 },
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
	/** Bans the rules found inside pasted material: added only if Jev confirms they restrict the assistant. */
	candidates?: PolicySpec[];
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
	// Nor for a long pasted message: its bans are usually for someone else (a prompt for another AI, a spec) (E17).
	const pasted = framing(input.message) !== input.message;
	if (!rulesRestricted && !pasted) {
		for (const [name, d] of Object.entries(BUILTIN_DENIES)) {
			if (!activeKeys.has(`DENY|${d.action}|${d.resource}`)) questions[`set_${name}`] = d.question;
		}
	}
	// holds ("先别改", read-only) end at a go-ahead; older sessions have read-only without the marker
	const readOnly = existing.filter((p) => p.effect === "DENY" && (p.until === "go_ahead" || (p.action === "modify" && p.resource === "*")));
	questions.new_prohibition = { type: "noul", instructions: "new_user_message forbids the assistant from doing something." };
	questions.new_permission = { type: "noul", instructions: "new_user_message gives the assistant permission to do something it was not allowed to do." };
	if (input.createdByRules.some((p) => p.effect === "ALLOW" && p.scope === "session")) {
		questions.temporary = { type: "noul", instructions: "The permission in new_user_message is only for a single use or the current step (for example 'this time', 'just once')." };
	}
	if (input.hasGoalScoped) questions.new_task = { type: "noul", instructions: "new_user_message starts a new, unrelated task instead of continuing the current one." };
	for (const p of input.createdByRules.filter((c) => c.action === "custom")) {
		// each question sees the whole state; the sentence it is about goes in its instructions
		questions[`kind_${p.id}`] = {
			...RULE_OR_GUIDANCE,
			instructions: { ...RULE_OR_GUIDANCE.instructions, question: `What kind of instruction is this sentence: "${truncate(p.resource, 200)}"?` },
		} as unknown as Question;
		questions[`real_${p.id}`] = {
			type: "noul",
			instructions: `The sentence "${truncate(p.resource, 200)}" forbids the assistant from taking some action (a real prohibition, not advice like "don't forget" or reassurance like "don't worry").`,
		};
	}

	const state = {
		new_user_message: headAndTail(input.message),
		policies_before_message: existing.map((p) => ({ id: p.id, said: truncate(p.sourceQuote, 200), rule: describe(p) })),
	};
	// The go-ahead question gets its own request with a minimal state: sharing the full state (the policy list)
	// cut it from 8/9 to 5/9 lifts caught, with no false lifts either way (E12). The two run in parallel.
	// Restrictions the parser just added: does the message restrict the assistant at all (E16)? Packed into the main
	// request (TypeSafe: one request for all questions): same answers as a request of its own, 0/18 changed.
	const parsed = input.createdByRules.filter((p) => p.effect !== "ALLOW");
	const candidates = input.candidates ?? [];
	const directiveQs: Record<string, Question> = Object.fromEntries([
		...parsed.map((p) => [`dir_${p.id}`, directiveQuestion(describe(p))]),
		...candidates.map((c, i) => [`cand_${i}`, directiveQuestion(`${describe({ ...c, id: "", exceptions: [], status: "active", provenance: { at: c.at, seq: 0, by: c.by } })}, from "${truncate(c.sourceQuote, 160)}"`)]),
	]);
	if (candidates.length) directiveQs.paste_kind = PASTE_KIND as unknown as Question;
	const lines = [...new Set(candidates.map((c) => c.sourceQuote))];
	lines.forEach((line, i) => (directiveQs[`own_${i}`] = ownLineQuestion(line)));
	Object.assign(questions, directiveQs);
	const [main, goRequest] = await Promise.all([
		ask(judge, state, questions, timeoutMs),
		readOnly.length
			? ask(judge, { new_user_message: truncate(input.message, 3000), earlier_policy: truncate(readOnly.at(-1)!.sourceQuote, 300) }, { go_ahead: GO_AHEAD }, timeoutMs)
			: Promise.resolve(undefined),
	]);
	const { error, ms } = main;
	if (!main.answers) return { ...empty, ms, error };
	const answers = { ...main.answers, ...(goRequest?.answers ?? {}) };

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
	// A permission the rules found in the same message ("you can edit notes.txt only", "this once") is narrower than a go-ahead.
	const scopedAllow = input.createdByRules.some((c) => c.effect === "ALLOW");
	if (go && !scopedAllow) {
		const passes = (t: { p: number; confidence: number }) => go.p >= t.p && go.confidence >= t.confidence;
		const held = readOnly.filter((p) => (p.until === "go_ahead" ? passes(THRESHOLDS.goAheadHold) : passes(THRESHOLDS.goAhead)));
		for (const p of held) {
			if (out.ops.some((o) => o.op === "supersede" && o.id === p.id)) continue;
			out.ops.push({ op: "supersede", id: p.id, reason: `go-ahead (jev p=${go.p.toFixed(2)}): "${truncate(input.message, 120)}"`, by: "jev" });
			if (out.deltas[p.id]) out.deltas[p.id].applied = true;
		}
	}

	for (const [name, d] of Object.entries(BUILTIN_DENIES)) {
		if ((noul(`set_${name}`) ?? 0) >= THRESHOLDS.add && !input.createdByRules.some((p) => p.effect === "DENY" && p.action === d.action && p.resource === d.resource)) {
			out.ops.push({
				op: "add",
				spec: { effect: "DENY", action: d.action, resource: d.resource, scope: "session", sourceQuote: truncate(input.message, 300), by: "jev", at: input.at, ...(d.resource === "*" && d.action === "modify" ? { until: "go_ahead" as const } : {}) },
			});
		}
	}
	if ((noul("temporary") ?? 0) >= THRESHOLDS.temporary) {
		for (const p of input.createdByRules) if (p.effect === "ALLOW" && p.scope === "session") out.ops.push({ op: "rescope", id: p.id, scope: "once", by: "jev" });
	}
	if ((noul("new_task") ?? 0) >= THRESHOLDS.newTask) out.ops.unshift({ op: "end", scope: "goal", before: input.at });
	// Pasted material: its bans count only when Jev is sure the whole paste is a task for this assistant, and each
	// ban then passes the same not-a-rule check as any other.
	// …or when that line is the user's own words inside the paste.
	const task = choiceP("paste_kind", "task_for_assistant");
	if (task) out.signals.paste_task = task.p;
	const isTask = !!task && task.p >= THRESHOLDS.pastedTask.p && task.confidence >= THRESHOLDS.pastedTask.confidence;
	candidates.forEach((c, i) => {
		const own = choiceP(`own_${lines.indexOf(c.sourceQuote)}`, "user_own");
		const isOwn = !!own && own.p >= THRESHOLDS.ownLine.p && own.confidence >= THRESHOLDS.ownLine.confidence;
		const d = choiceP(`cand_${i}`, "not_a_rule");
		const notRule = !!d && d.p >= THRESHOLDS.notARule.p && d.confidence >= THRESHOLDS.notARule.confidence;
		if ((isTask || isOwn) && !notRule) out.ops.push({ op: "add", spec: { ...c, by: "jev", at: input.at } });
	});
	const notRules = new Set<string>();
	for (const p of parsed) {
		const d = choiceP(`dir_${p.id}`, "not_a_rule");
		if (d) out.signals[`not_a_rule_${p.id}`] = d.p;
		if (d && d.p >= THRESHOLDS.notARule.p && d.confidence >= THRESHOLDS.notARule.confidence) {
			notRules.add(p.id);
			out.ops.push({ op: "supersede", id: p.id, reason: `not a restriction on the assistant (jev p=${d.p.toFixed(2)})`, by: "jev" });
		}
	}
	for (const p of input.createdByRules.filter((c) => c.action === "custom" && !notRules.has(c.id))) {
		const v = noul(`real_${p.id}`);
		const g = choiceP(`kind_${p.id}`, "design_guidance");
		if (g) out.signals[`guidance_${p.id}`] = g.p;
		if (v !== undefined && v < THRESHOLDS.reject) {
			out.ops.push({ op: "supersede", id: p.id, reason: `not a prohibition (jev p=${v.toFixed(2)})`, by: "jev" });
		} else if (g && g.p >= THRESHOLDS.guidance.p && g.confidence >= THRESHOLDS.guidance.confidence) {
			out.ops.push({ op: "supersede", id: p.id, reason: `design guidance, not enforceable on a tool call (jev p=${g.p.toFixed(2)})`, by: "jev" });
		}
	}
	return out;
}
