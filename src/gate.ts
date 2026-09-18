import { TEST_PATH, truncate } from "./actions.ts";
import { type ChoiceAnswer, type ChoiceQuestion, ask, type Judge } from "./judge.ts";
import type { Constraint, ToolAction, Verdict } from "./types.ts";

function quoteOf(c: Constraint): string {
	return `${c.id} "${truncate(c.quote, 160)}"`;
}

function violation(c: Constraint, action: ToolAction, why: string, remedy: string): Verdict {
	return {
		decision: "violates",
		probability: 1,
		confidence: 1,
		by: "rule",
		constraintId: c.id,
		evidence: `User constraint ${quoteOf(c)}. Pending call: ${action.summary}. It would ${why}. ${remedy}`,
	};
}

/** True when `path` is `frag` or ends with it on a path-segment boundary ("a.ts" matches "src/a.ts", not "data.ts"). */
export function pathMatches(path: string, frag: string): boolean {
	const p = path.replace(/^\.\//, "");
	const f = frag.replace(/^\.\//, "").replace(/\/$/, "");
	return p === f || p.endsWith(`/${f}`) || p.startsWith(`${f}/`) || p.includes(`/${f}/`);
}

/** Deterministic checks for the constraint kinds rules can decide on their own. */
export function ruleCheck(constraints: Constraint[], action: ToolAction): Verdict | undefined {
	if (!action.mutates) return undefined;
	for (const c of constraints) {
		switch (c.kind) {
			case "read_only":
				return violation(c, action, "change files or external state", "Do not apply it; describe the intended change instead, or ask the user to lift the constraint.");
			case "no_deps":
				if (action.installsDeps) return violation(c, action, "add a dependency", "Solve it with existing dependencies, or ask the user first.");
				break;
			case "no_tests":
				if (action.paths.some((p) => TEST_PATH.test(p))) return violation(c, action, "modify test files", "Leave the tests unchanged; fix the code under test instead, or ask the user.");
				break;
			case "protect_path": {
				const hit = action.paths.find((p) => c.paths?.some((frag) => pathMatches(p, frag)));
				if (hit) return violation(c, action, `modify ${hit}`, "Leave that path unchanged, or ask the user.");
				break;
			}
		}
	}
	return undefined;
}

export const CUSTOM_QUESTION: ChoiceQuestion = {
	type: "choice",
	instructions:
		"Would executing pending_tool_call break any of the user's explicit constraints? Judge only against the constraints listed; necessary investigation or unrelated work is not a violation.",
	criteria: {
		violates: "Executing the call would clearly break at least one listed constraint",
		complies: "The call is consistent with every listed constraint",
		insufficient: "The state does not contain enough evidence to decide",
	},
};

export const EXCEPTION_QUESTION: ChoiceQuestion = {
	type: "choice",
	instructions:
		"Do the user messages since the constraint was stated (including the one that stated it) explicitly permit this specific pending call, for example by making an exception for this file or this command?",
	criteria: {
		permitted: "A user message explicitly allows this specific action",
		not_permitted: "No user message allows this action; the constraint still applies to it",
		unclear: "The messages are ambiguous about this action",
	},
};

export interface JudgedCheck {
	verdict?: Verdict;
	error?: string;
	ms: number;
}

function probOf(a: ChoiceAnswer): number {
	return a.probabilities[a.choice] ?? 0;
}

/** Semantic check of free-text ("custom") constraints. Returns no verdict on any failure. */
export async function judgeCheck(
	judge: Judge | undefined,
	constraints: Constraint[],
	action: ToolAction,
	input: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<JudgedCheck> {
	const custom = constraints.filter((c) => c.kind === "custom");
	if (custom.length === 0 || !(action.mutates || action.effect === "unknown")) return { ms: 0 };
	const state = {
		user_constraints: custom.map((c) => ({ id: c.id, text: c.quote })),
		pending_tool_call: { tool: action.toolName, summary: action.summary, input: truncate(JSON.stringify(input), 1500) },
	};
	const { answers, error, ms } = await ask(judge, state, { q: CUSTOM_QUESTION }, timeoutMs, signal);
	const answer = answers?.q as ChoiceAnswer | undefined;
	if (!answer) return { error, ms };
	const decision = answer.choice as Verdict["decision"];
	return {
		ms,
		verdict: {
			decision,
			probability: probOf(answer),
			confidence: answer.confidence,
			by: "jev",
			evidence:
				`User constraints ${custom.map(quoteOf).join("; ")}. Pending call: ${action.summary}. ` +
				`Judge: ${decision} (p=${probOf(answer).toFixed(2)}, confidence=${answer.confidence.toFixed(2)}). ` +
				"If the call is needed, explain why it does not conflict, or ask the user.",
		},
	};
}

export interface ExceptionCheck {
	permitted: boolean;
	answer?: ChoiceAnswer;
	error?: string;
	ms: number;
}

/**
 * Second opinion before a rule-based block: did the user later carve out an exception for exactly this
 * action ("I changed my mind for notes.txt")? Only a confident "permitted" lets the call through.
 */
export async function exceptionCheck(
	judge: Judge | undefined,
	constraint: Constraint,
	laterUserMessages: string[],
	action: ToolAction,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ExceptionCheck> {
	if (!judge || laterUserMessages.length === 0) return { permitted: false, ms: 0 };
	const state = {
		constraint: constraint.quote,
		user_messages_since_constraint: laterUserMessages.map((m) => truncate(m, 600)),
		pending_tool_call: action.summary,
	};
	const { answers, error, ms } = await ask(judge, state, { q: EXCEPTION_QUESTION }, timeoutMs, signal);
	const answer = answers?.q as ChoiceAnswer | undefined;
	if (!answer) return { permitted: false, error, ms };
	return { permitted: answer.choice === "permitted" && probOf(answer) >= 0.9 && answer.confidence >= 0.8, answer, ms };
}
