import { TEST_PATH, truncate } from "./actions.ts";
import { ask, type Judge } from "./judge.ts";
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
				const hit = action.paths.find((p) => c.paths?.some((frag) => p === frag || p.endsWith(`/${frag}`) || p.includes(frag)));
				if (hit) return violation(c, action, `modify ${hit}`, "Leave that path unchanged, or ask the user.");
				break;
			}
		}
	}
	return undefined;
}

export const CUSTOM_QUESTION = {
	instructions:
		"Would executing pending_tool_call break any of the user's explicit constraints? Judge only against the constraints listed; necessary investigation or unrelated work is not a violation.",
	criteria: {
		violates: "Executing the call would clearly break at least one listed constraint",
		complies: "The call is consistent with every listed constraint",
		insufficient: "The state does not contain enough evidence to decide",
	},
};

export interface JudgedCheck {
	verdict?: Verdict;
	error?: string;
	ms: number;
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
	const { answer, error, ms } = await ask(judge, state, CUSTOM_QUESTION, timeoutMs, signal);
	if (!answer) return { error, ms };
	const decision = answer.choice as Verdict["decision"];
	return {
		ms,
		verdict: {
			decision,
			probability: answer.probabilities[decision] ?? 0,
			confidence: answer.confidence,
			by: "jev",
			evidence:
				`User constraints ${custom.map(quoteOf).join("; ")}. Pending call: ${action.summary}. ` +
				`Judge: ${decision} (p=${(answer.probabilities[decision] ?? 0).toFixed(2)}, confidence=${answer.confidence.toFixed(2)}). ` +
				"If the call is needed, explain why it does not conflict, or ask the user.",
		},
	};
}
