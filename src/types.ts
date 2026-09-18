export type Mode = "off" | "shadow" | "enforce";

export type SideEffect = "read" | "write" | "exec" | "unknown";

export interface ToolAction {
	toolName: string;
	effect: SideEffect;
	/** True when the call can change files, packages, git state or anything outside the process. */
	mutates: boolean;
	installsDeps: boolean;
	gitPush: boolean;
	gitCommit: boolean;
	/** Runs a test suite (used by REQUIRE_BEFORE "run tests before …"). */
	runsTests: boolean;
	paths: string[];
	/** One-line human-readable description, used as evidence. */
	summary: string;
}

export type Decision = "violates" | "complies" | "insufficient";

export interface Verdict {
	decision: Decision;
	/** Probability of the chosen decision (rules report 1). */
	probability: number;
	confidence: number;
	by: "rule" | "jev";
	constraintId?: string;
	/** Evidence shown to the model and the user. Never a bare judgement. */
	evidence: string;
}

export interface HeedConfig {
	mode: Mode;
	/** Jev verdicts need both of these to block in enforce mode. */
	blockProbability: number;
	blockConfidence: number;
	judgeTimeoutMs: number;
	/** Maximum blocks + notes per agent run. */
	maxInterventionsPerRun: number;
	/** Identical failures (same command, same error, no file change in between) before a note is added. */
	repeatThreshold: number;
}

export const DEFAULT_CONFIG: HeedConfig = {
	mode: "shadow",
	blockProbability: 0.9,
	blockConfidence: 0.8,
	// Observed 235–1550ms via OpenRouter. Only mutating calls under custom constraints wait on it.
	judgeTimeoutMs: 2500,
	maxInterventionsPerRun: 3,
	repeatThreshold: 2,
};
