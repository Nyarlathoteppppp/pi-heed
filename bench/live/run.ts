// Live benchmark: real pi, real model, real sandbox repos. Each scenario runs with pi-heed off and in
// enforce mode, several times; outcomes come from the file system and git.
//
//   PI_HEED_ENV_FILE=... node bench/live/run.ts --reps 3 --parallel 3 [--only S1,S2] [--out bench/live/results.json]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import { SCENARIOS, type Helpers, type Scenario } from "./scenarios.ts";

const exec = promisify(execCb);
const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const reps = Number(arg("reps", "3"));
/** reps for scenarios where the policy changes mid-session (pi-heed's target) */
const repsChanging = Number(arg("reps-changing", arg("reps", "3")));
const model = arg("model", "antigravity/gemini-3.8-flash")!;
/** condition → environment: "inform" = enforce + rules in the system prompt */
const CONDITION_ENV: Record<string, Record<string, string>> = {
	off: { PI_HEED_MODE: "off" },
	enforce: { PI_HEED_MODE: "enforce", PI_HEED_INFORM: "0" },
	inform: { PI_HEED_MODE: "enforce", PI_HEED_INFORM: "1" },
};
const parallel = Number(arg("parallel", "3"));
const only = arg("only")?.split(",");
const conditions = (arg("conditions", "off,enforce,inform") as string).split(",");
const turnTimeout = Number(arg("timeout", "240")) * 1000;
const root = arg("root", join(process.env.TMPDIR ?? "/tmp", "pi-heed-live"))!;
const outPath = arg("out", join(dirname(new URL(import.meta.url).pathname), "results.json"))!;

interface Job {
	scenario: Scenario;
	condition: string;
	rep: number;
	dir: string;
}
interface Result {
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
	error?: string;
}

async function sh(cmd: string, cwd: string) {
	try {
		const { stdout, stderr } = await exec(cmd, { cwd, timeout: 60_000, maxBuffer: 10 << 20 });
		return { ok: true, out: stdout + stderr };
	} catch (e: any) {
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
}

async function setup(job: Job) {
	rmSync(job.dir, { recursive: true, force: true });
	const repo = join(job.dir, "repo");
	mkdirSync(repo, { recursive: true });
	for (const [p, c] of Object.entries(job.scenario.files)) {
		mkdirSync(dirname(join(repo, p)), { recursive: true });
		writeFileSync(join(repo, p), c);
	}
	await sh("git init -q -b main && git config user.email bench@example.com && git config user.name bench && git add -A && git commit -q -m initial", repo);
	if (job.scenario.remote) {
		await sh("git init -q --bare -b main ../remote.git && git remote add origin ../remote.git && git push -q -u origin main", repo);
	}
	return repo;
}

function sessionFile(dir: string): string | undefined {
	const s = join(dir, "sessions");
	if (!existsSync(s)) return undefined;
	const f = readdirSync(s).filter((x) => x.endsWith(".jsonl"));
	return f.length ? join(s, f[0]) : undefined;
}

function sessionLines(dir: string): number {
	const f = sessionFile(dir);
	return f ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0;
}

/** One pi turn. Returns false if pi produced nothing (the known print-mode start-up hang). */
function turn(job: Job, repo: string, prompt: string, first: boolean): Promise<"ok" | "hang" | "timeout"> {
	const before = sessionLines(job.dir);
	return new Promise((resolve) => {
		const args = ["--session-dir", join(job.dir, "sessions"), "--model", model, ...(first ? [] : ["-c"]), "-p", prompt];
		const child = spawn("pi", args, {
			cwd: repo,
			// Isolation: other globally installed Jev extensions must not act during the benchmark.
			env: { ...process.env, PI_JEV_CONTEXT_MODE: "off", ...CONDITION_ENV[job.condition] },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve(sessionLines(job.dir) > before ? "timeout" : "hang");
		}, turnTimeout);
		child.on("exit", () => {
			clearTimeout(timer);
			writeFileSync(join(job.dir, `turn.log`), out, { flag: "a" });
			resolve(sessionLines(job.dir) > before ? "ok" : "hang");
		});
	});
}

async function runJob(job: Job): Promise<Result> {
	const t0 = Date.now();
	const repo = await setup(job);
	let hangs = 0;
	let completed = 0;
	let error: string | undefined;
	for (let i = 0; i < job.scenario.turns.length; i++) {
		let r = await turn(job, repo, job.scenario.turns[i], i === 0);
		// the print-mode start-up hang happens before pi reads anything; retrying is safe
		for (let retry = 0; r === "hang" && retry < 3; retry++) {
			hangs++;
			r = await turn(job, repo, job.scenario.turns[i], i === 0 && sessionLines(job.dir) === 0);
		}
		if (r === "hang") {
			error = `turn ${i + 1} never started`;
			break;
		}
		completed++;
	}
	const h: Helpers = {
		changed: async () => {
			const diff = await sh("git diff --name-only $(git rev-list --max-parents=0 HEAD)", repo);
			const untracked = await sh("git ls-files --others --exclude-standard", repo);
			return [...new Set([...diff.out.split("\n"), ...untracked.out.split("\n")].map((s) => s.trim()).filter(Boolean))];
		},
		read: (p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), "utf8") : undefined),
		exists: (p) => existsSync(join(repo, p)),
		sh: (cmd) => sh(cmd, repo),
		executed: () => executed,
	};
	const blocked: string[] = [];
	let heedDecisions = 0;
	const models = new Set<string>();
	const executed: Array<{ tool: string; input: Record<string, any>; turn: number }> = [];
	const f = sessionFile(job.dir);
	if (f) {
		const calls = new Map<string, { tool: string; input: Record<string, any>; turn: number }>();
		let turnNo = 0;
		for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
			const e = JSON.parse(line);
			if (e.type === "message") {
				const m = e.message;
				if (m.role === "user") turnNo++;
				if (m.role === "assistant") {
					if (m.provider) models.add(`${m.provider}/${m.model}`);
					for (const part of m.content ?? []) if (part.type === "toolCall") calls.set(part.id, { tool: part.name, input: part.arguments ?? {}, turn: turnNo });
				}
				if (m.role === "toolResult" && !m.isError && calls.has(m.toolCallId)) executed.push(calls.get(m.toolCallId)!);
			}
			if (e.type === "custom" && e.customType === "heed" && e.data?.kind === "gate") {
				heedDecisions++;
				if (e.data.acted) blocked.push(`${e.data.summary}  [${e.data.policy ?? e.data.verdict?.by}]`);
			}
		}
	}
	return {
		scenario: job.scenario.id,
		condition: job.condition,
		rep: job.rep,
		model: [...models].join(","),
		violated: await job.scenario.violated(h),
		succeeded: await job.scenario.succeeded(h),
		blocked,
		heedDecisions,
		turnsCompleted: completed,
		hangs,
		seconds: Math.round((Date.now() - t0) / 1000),
		...(error ? { error } : {}),
	};
}

const jobs: Job[] = [];
for (const s of SCENARIOS.filter((s) => !only || only.includes(s.id)))
	for (let rep = 1; rep <= (s.changing ? repsChanging : reps); rep++) for (const condition of conditions) jobs.push({ scenario: s, condition, rep, dir: join(root, `${s.id}-${condition}-${rep}`) });

const results: Result[] = existsSync(outPath) && process.argv.includes("--resume") ? JSON.parse(readFileSync(outPath, "utf8")) : [];
const done = new Set(results.map((r) => `${r.scenario}-${r.condition}-${r.rep}`));
const queue = jobs.filter((j) => !done.has(`${j.scenario.id}-${j.condition}-${j.rep}`));
console.log(`${queue.length} runs, ${parallel} at a time, model ${model}, sandboxes in ${root}`);

async function worker() {
	for (let job = queue.shift(); job; job = queue.shift()) {
		const r = await runJob(job).catch((e) => ({ scenario: job!.scenario.id, condition: job!.condition, rep: job!.rep, violated: false, succeeded: false, blocked: [], heedDecisions: 0, turnsCompleted: 0, hangs: 0, seconds: 0, error: String(e) }) as Result);
		results.push(r);
		writeFileSync(outPath, `${JSON.stringify(results, null, "\t")}\n`);
		console.log(`${r.scenario} ${r.condition.padEnd(7)} #${r.rep}  violated=${r.violated || "no"}  task=${r.succeeded ? "ok" : "FAIL"}  blocked=${r.blocked.length}  turns=${r.turnsCompleted}  hangs=${r.hangs}  ${r.seconds}s${r.error ? `  ERROR ${r.error}` : ""}`);
	}
}
await Promise.all(Array.from({ length: parallel }, worker));

// summary
console.log("\nscenario  condition  violations  task ok  blocked calls");
for (const s of [...new Set(results.map((r) => r.scenario))].sort()) {
	for (const c of conditions) {
		const rs = results.filter((r) => r.scenario === s && r.condition === c && !r.error);
		console.log(`${s.padEnd(9)} ${c.padEnd(10)} ${`${rs.filter((r) => r.violated).length}/${rs.length}`.padEnd(11)} ${`${rs.filter((r) => r.succeeded).length}/${rs.length}`.padEnd(8)} ${rs.reduce((a, r) => a + r.blocked.length, 0)}`);
	}
}
