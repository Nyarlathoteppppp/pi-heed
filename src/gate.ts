import { truncate } from "./actions.ts";
import { type ChoiceAnswer, type ChoiceQuestion, ask, type Judge } from "./judge.ts";
import type { Policy, Resolution } from "./policy.ts";
import type { ToolAction, Verdict } from "./types.ts";

function quoteOf(p: Policy): string {
	return `${p.id} "${truncate(p.sourceQuote, 160)}"`;
}

/** Evidence-carrying verdict for a restrictive policy that decided a call. */
export function policyVerdict(r: Resolution, action: ToolAction): Verdict | undefined {
	const p = r.policy;
	if (!p) return undefined;
	const on = r.target ? ` (${r.target})` : "";
	let why: string;
	let remedy: string;
	switch (p.effect) {
		case "REQUIRE_CONFIRMATION":
			why = "needs the user's explicit confirmation first";
			remedy = "Ask the user before doing this.";
			break;
		case "REQUIRE_BEFORE":
			why = `requires ${p.prerequisite} to pass first, with no file changes since`;
			remedy = `Run the ${p.prerequisite} first, then retry.`;
			break;
		default:
			why = p.action === "modify" ? `modify ${p.resource === "*" ? "files or external state" : p.resource === "tests" ? "test files" : p.resource}${on}` : `${p.action.replace("_", " ")}`;
			why = `is forbidden: it would ${why}`;
			remedy =
				p.resource === "tests"
					? "Leave the tests unchanged; fix the code under test instead, or ask the user."
					: "Do not apply it; describe the intended change instead, or ask the user to lift the policy.";
	}
	const exceptions = p.exceptions.length ? ` Exceptions granted: ${p.exceptions.join(", ")}.` : "";
	return {
		decision: "violates",
		probability: 1,
		confidence: 1,
		by: "rule",
		constraintId: p.id,
		evidence: `User policy ${quoteOf(p)}. Pending call: ${action.summary}. It ${why}.${exceptions} ${remedy}`,
	};
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

// Jev anchors on what it reads first: the pending call and the user's messages go before the old constraint,
// and the question says newer messages win (Jev lab: confident answers 75% → 100% right).
export const EXCEPTION_QUESTION: ChoiceQuestion = {
	type: "choice",
	instructions:
		"Read user_messages_since_constraint in order; a later message overrides an earlier one where they conflict, and all of them override the constraint. Taken together, do they ask for, or clearly allow, pending_tool_call?",
	criteria: {
		yes: "Yes, this exact call is asked for or clearly allowed",
		no: "No, the messages do not cover this call",
		unclear: "Cannot tell",
	},
};

/** Tools whose side effects are known well enough to ask once whether they can break a free-text prohibition. */
export const RELEVANCE_TOOLS: Record<string, string> = {
	edit: "edit: replaces text in one existing file on disk",
	write: "write: creates or overwrites one file on disk",
	bash: "bash: runs an arbitrary shell command",
};

/**
 * Per free-text prohibition, asked once for all known tools in one request: which tools cannot break it at all?
 * Lets pi-heed skip per-call checks that can only add risk ("never call the production API" vs a file edit).
 */
export async function toolRelevance(judge: Judge | undefined, policy: Policy, timeoutMs: number): Promise<Record<string, boolean>> {
	const questions = Object.fromEntries(
		Object.entries(RELEVANCE_TOOLS).map(([tool, desc]) => [
			tool,
			{
				type: "choice" as const,
				instructions: `Can a single call to this tool violate the constraint? Tool: ${desc}`,
				criteria: { can_violate: "Yes, one call of this tool can directly break the constraint", cannot: "No, this tool cannot break the constraint by itself", unclear: "It depends on details not given" },
			},
		]),
	);
	const { answers } = await ask(judge, { constraint: policy.resource }, questions, timeoutMs);
	const cannot: Record<string, boolean> = {};
	for (const tool of Object.keys(RELEVANCE_TOOLS)) {
		const a = answers?.[tool] as ChoiceAnswer | undefined;
		cannot[tool] = !!a && a.type === "choice" && a.choice === "cannot" && (a.probabilities.cannot ?? 0) >= 0.9 && a.confidence >= 0.8;
	}
	return cannot;
}

export interface JudgedCheck {
	verdict?: Verdict;
	error?: string;
	ms: number;
}

function probOf(a: ChoiceAnswer): number {
	return a.probabilities[a.choice] ?? 0;
}

/** Semantic check of free-text (custom) prohibitions. Returns no verdict on any failure. */
export async function judgeCheck(
	judge: Judge | undefined,
	custom: Policy[],
	action: ToolAction,
	input: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<JudgedCheck> {
	if (custom.length === 0 || !(action.mutates || action.effect === "unknown")) return { ms: 0 };
	const state = {
		user_constraints: custom.map((c) => ({ id: c.id, text: c.resource })),
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
				`User policies ${custom.map(quoteOf).join("; ")}. Pending call: ${action.summary}. ` +
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
 * Second opinion before a rule-based block: did the user carve out an exception for exactly this
 * action that the rules didn't parse? Only a confident "permitted" lets the call through.
 */
export async function exceptionCheck(
	judge: Judge | undefined,
	policy: Policy,
	messagesSince: string[],
	action: ToolAction,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ExceptionCheck> {
	if (!judge || messagesSince.length === 0) return { permitted: false, ms: 0 };
	const state = {
		pending_tool_call: action.summary,
		user_messages_since_constraint: messagesSince.map((m) => truncate(m, 600)),
		constraint: policy.sourceQuote,
	};
	const { answers, error, ms } = await ask(judge, state, { q: EXCEPTION_QUESTION }, timeoutMs, signal);
	const answer = answers?.q as ChoiceAnswer | undefined;
	if (!answer) return { permitted: false, error, ms };
	return { permitted: answer.choice === "yes" && probOf(answer) >= 0.9 && answer.confidence >= 0.8, answer, ms };
}
