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
	/** bash only: the paths it writes, when every write in the command could be read off it; else undefined. */
	writes?: string[];
	/** bash only: can reach other systems or run arbitrary code (network clients, interpreters, scripts), so a
	 * free-text rule ("never call the production API") has to be checked even when no file changes. */
	reachesOut?: boolean;
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
	/** Advice stops at this intervention count; forbidden calls still require approval. */
	maxInterventionsPerRun: number;
	/** Identical failures (same command, same error, no file change in between) before a note is added. */
	repeatThreshold: number;
	/** Tell the model the active policies in the system prompt (changes only when the policy does). */
	inform: boolean;
	/**
	 * Speed bump: a free-text verdict at or above this probability (but below blockProbability) stops the call
	 * for the user's approval, including retries. 0 disables.
	 */
	bumpProbability: number;
	/**
	 * Give Jev the current task (task ledger) with a free-text rule or an `unless` it judges. Off until measured:
	 * a larger shared state has cost a question accuracy before (E12).
	 */
	taskContext: boolean;
	/**
	 * Before blocking a call in enforce mode, ask the human (pi's dialog, TUI or RPC) whether to block it, let it
	 * through once, or let it through and drop the rule. 0 disables; otherwise the dialog's timeout in ms, after which
	 * the call is blocked as before. Without a UI (print / json mode) pi-heed blocks without asking.
	 */
	askTimeoutMs: number;
}

export const DEFAULT_CONFIG: HeedConfig = {
	mode: "shadow",
	blockProbability: 0.9,
	blockConfidence: 0.8,
	// Observed 235–1550ms via OpenRouter. Only mutating calls under custom constraints wait on it.
	judgeTimeoutMs: 2500,
	maxInterventionsPerRun: 3,
	repeatThreshold: 2,
	inform: false,
	bumpProbability: 0,
	taskContext: false,
	askTimeoutMs: 60_000,
};
