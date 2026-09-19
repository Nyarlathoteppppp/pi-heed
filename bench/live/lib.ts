// Shared by the live runner and the offline rescorer: reading a sandbox and its pi session.
import { exec as execCb } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Helpers, Scenario } from "./scenarios.ts";

const exec = promisify(execCb);

export interface Result {
	scenario: string;
	condition: string;
	rep: number;
	/** provider/model the session actually used, read from the session file */
	model?: string;
	/** what the model did that broke the constraint (from git and the calls that actually ran), or false */
	violated: string | false;
	succeeded: boolean;
	blocked: string[];
	heedDecisions: number;
	turnsCompleted: number;
	hangs: number;
	seconds: number;
	/** set when the run is not usable (never started, or the model never answered) */
	error?: string;
}

export async function sh(cmd: string, cwd: string) {
	try {
		const { stdout, stderr } = await exec(cmd, { cwd, timeout: 60_000, maxBuffer: 10 << 20 });
		return { ok: true, out: stdout + stderr };
	} catch (e: any) {
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
}

export function sessionFile(dir: string): string | undefined {
	const s = join(dir, "sessions");
	if (!existsSync(s)) return undefined;
	const f = readdirSync(s).filter((x) => x.endsWith(".jsonl"));
	return f.length ? join(s, f[0]) : undefined;
}

export interface SessionFacts {
	models: string[];
	executed: Array<{ tool: string; input: Record<string, any>; turn: number }>;
	blocked: string[];
	heedDecisions: number;
	assistantMessages: number;
	/** assistant messages that ended in a provider error (quota, auth, network) */
	modelErrors: number;
	firstModelError?: string;
}

export function readSession(dir: string): SessionFacts {
	const facts: SessionFacts = { models: [], executed: [], blocked: [], heedDecisions: 0, assistantMessages: 0, modelErrors: 0 };
	const f = sessionFile(dir);
	if (!f) return facts;
	const models = new Set<string>();
	const calls = new Map<string, { tool: string; input: Record<string, any>; turn: number }>();
	let turn = 0;
	for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
		const e = JSON.parse(line);
		if (e.type === "message") {
			const m = e.message;
			if (m.role === "user") turn++;
			if (m.role === "assistant") {
				facts.assistantMessages++;
				if (m.stopReason === "error") {
					facts.modelErrors++;
					facts.firstModelError ??= String(m.errorMessage ?? "error").slice(0, 120);
				}
				if (m.provider) models.add(`${m.provider}/${m.model}`);
				for (const part of m.content ?? []) if (part.type === "toolCall") calls.set(part.id, { tool: part.name, input: part.arguments ?? {}, turn });
			}
			if (m.role === "toolResult" && !m.isError && calls.has(m.toolCallId)) facts.executed.push(calls.get(m.toolCallId)!);
		}
		if (e.type === "custom" && e.customType === "heed" && e.data?.kind === "gate") {
			facts.heedDecisions++;
			if (e.data.acted) facts.blocked.push(`${e.data.summary}  [${e.data.policy ?? e.data.verdict?.by}]`);
		}
	}
	facts.models = [...models];
	return facts;
}

export function helpersFor(repo: string, facts: SessionFacts): Helpers {
	return {
		changed: async () => {
			const diff = await sh("git diff --name-only $(git rev-list --max-parents=0 HEAD)", repo);
			const untracked = await sh("git ls-files --others --exclude-standard", repo);
			return [...new Set([...diff.out.split("\n"), ...untracked.out.split("\n")].map((s) => s.trim()).filter(Boolean))];
		},
		read: (p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), "utf8") : undefined),
		exists: (p) => existsSync(join(repo, p)),
		sh: (cmd) => sh(cmd, repo),
		executed: () => facts.executed,
	};
}

/** Scores one finished sandbox. A run where the model never answered is marked unusable, not scored as compliant. */
export async function score(
	scenario: Scenario,
	condition: string,
	rep: number,
	dir: string,
	extra: { turnsCompleted: number; hangs: number; seconds: number; error?: string },
): Promise<Result> {
	const facts = readSession(dir);
	const h = helpersFor(join(dir, "repo"), facts);
	let error = extra.error;
	if (!error && facts.assistantMessages > 0 && facts.modelErrors === facts.assistantMessages) error = `model never answered: ${facts.firstModelError}`;
	if (!error && facts.assistantMessages === 0) error = "no assistant messages";
	return {
		scenario: scenario.id,
		condition,
		rep,
		model: facts.models.join(","),
		violated: await scenario.violated(h),
		succeeded: await scenario.succeeded(h),
		blocked: facts.blocked,
		heedDecisions: facts.heedDecisions,
		turnsCompleted: extra.turnsCompleted,
		hangs: extra.hangs,
		seconds: extra.seconds,
		...(error ? { error } : {}),
	};
}
