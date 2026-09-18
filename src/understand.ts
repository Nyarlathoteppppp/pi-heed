import { truncate } from "./actions.ts";
import { ask, type Judge, type NoulAnswer, type Question } from "./judge.ts";
import type { Constraint, ConstraintKind } from "./types.ts";

// One Jev call per user message, many questions in one pass (Jev's fan-out pattern):
// catch paraphrased constraints the regexes miss, catch lifts, and weed out
// "don't forget to…"-style sentences the regexes wrongly took for prohibitions.
// Runs in the background; the gate waits for it only if a tool call arrives first.

type Builtin = Extract<ConstraintKind, "read_only" | "no_tests" | "no_deps">;

const SET: Record<Builtin, string> = {
	read_only: "The user explicitly forbids the assistant from modifying any files (read-only, review only, just look, no edits).",
	no_tests: "The user explicitly forbids the assistant from modifying, deleting, disabling or skipping tests.",
	no_deps: "The user explicitly forbids the assistant from adding or installing new dependencies or packages.",
};

const LIFT: Record<Builtin, string> = {
	read_only: "The user now allows the assistant to modify files in general, lifting an earlier read-only restriction.",
	no_tests: "The user now allows the assistant to modify tests, lifting an earlier restriction.",
	no_deps: "The user now allows the assistant to add dependencies, lifting an earlier restriction.",
};

export interface Understanding {
	add: Builtin[];
	lift: Builtin[];
	/** Custom constraints the rules created that are not real prohibitions. */
	reject: string[];
	ms: number;
	error?: string;
}

// Measured: real prohibitions 0.85+, non-constraints <=0.03. Lifts are weaker for Jev and costlier when wrong.
export const THRESHOLDS = { add: 0.8, lift: 0.9, reject: 0.2 };

export async function understand(
	judge: Judge | undefined,
	message: string,
	active: Constraint[],
	newCustom: Constraint[],
	timeoutMs: number,
): Promise<Understanding> {
	const empty: Understanding = { add: [], lift: [], reject: [], ms: 0 };
	if (!judge || !message.trim()) return empty;
	const activeKinds = new Set(active.map((c) => c.kind));
	const questions: Record<string, Question> = {};
	for (const kind of Object.keys(SET) as Builtin[]) {
		if (activeKinds.has(kind)) questions[`lift_${kind}`] = { type: "noul", instructions: LIFT[kind] };
		else questions[`set_${kind}`] = { type: "noul", instructions: SET[kind] };
	}
	for (const c of newCustom.slice(0, 6)) {
		questions[`real_${c.id}`] = {
			type: "noul",
			instructions: `The sentence "${truncate(c.quote, 200)}" forbids the assistant from taking some action (a real prohibition, not advice like "don't forget" or reassurance like "don't worry").`,
		};
	}
	const state = {
		new_user_message: truncate(message, 3000),
		currently_active_constraints: active.map((c) => truncate(c.quote, 200)),
	};
	const { answers, error, ms } = await ask(judge, state, questions, timeoutMs);
	if (!answers) return { ...empty, ms, error };
	const p = (key: string) => (answers[key] as NoulAnswer | undefined)?.noul;
	const out: Understanding = { ...empty, ms };
	for (const kind of Object.keys(SET) as Builtin[]) {
		if ((p(`set_${kind}`) ?? 0) >= THRESHOLDS.add) out.add.push(kind);
		if ((p(`lift_${kind}`) ?? 0) >= THRESHOLDS.lift) out.lift.push(kind);
	}
	for (const c of newCustom) {
		const v = p(`real_${c.id}`);
		if (v !== undefined && v < THRESHOLDS.reject) out.reject.push(c.id);
	}
	return out;
}
