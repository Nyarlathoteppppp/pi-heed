// Live benchmark: real pi, real model, real sandbox repos. Each scenario runs with pi-heed off and in
// enforce mode, several times; outcomes come from the file system and git.
//
//   PI_HEED_ENV_FILE=... node bench/live/run.ts --reps 3 --parallel 3 [--only S1,S2] [--out bench/live/results.json]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { snapshot } from "./lib.ts";
import { dirname, join } from "node:path";
import { type Result, score, sessionFile, sh } from "./lib.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";
const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const reps = Number(arg("reps", "3"));
/** reps for scenarios where the policy changes mid-session (pi-heed's target) */
const repsChanging = Number(arg("reps-changing", arg("reps", "3")));
const model = arg("model", "antigravity/gemini-3.8-flash")!;
/**
 * condition → environment. "inform" = enforce + rules in the system prompt (the 0.8 interpreter). "ledger" = the
 * main model records rules with heed_record / heed_lift; "ledger+regex" adds the parser's explicit hard rules.
 */
const CONDITION_ENV: Record<string, Record<string, string>> = {
	off: { PI_HEED_MODE: "off" },
	enforce: { PI_HEED_MODE: "enforce", PI_HEED_INFORM: "0", PI_HEED_PIPELINE: "interpret" },
	inform: { PI_HEED_MODE: "enforce", PI_HEED_INFORM: "1", PI_HEED_PIPELINE: "interpret" },
	interpret: { PI_HEED_MODE: "enforce", PI_HEED_INFORM: "1", PI_HEED_PIPELINE: "interpret" },
	ledger: { PI_HEED_MODE: "enforce", PI_HEED_INFORM: "1", PI_HEED_PIPELINE: "ledger" },
	"ledger+regex": { PI_HEED_MODE: "enforce", PI_HEED_INFORM: "1", PI_HEED_PIPELINE: "ledger+regex" },
};
const parallel = Number(arg("parallel", "3"));
const only = arg("only")?.split(",");
const conditions = (arg("conditions", "off,interpret,ledger,ledger+regex") as string).split(",");
const turnTimeout = Number(arg("timeout", "240")) * 1000;
const root = arg("root", join(process.env.TMPDIR ?? "/tmp", "pi-heed-live"))!;
const outPath = arg("out", join(dirname(new URL(import.meta.url).pathname), "results.json"))!;

interface Job {
	scenario: Scenario;
	condition: string;
	rep: number;
	dir: string;
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
	const snapshots: Array<Record<string, string>> = [snapshot(repo)];
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
		// what every file looked like after each turn: scoring that does not depend on pi-heed's own classifier
		snapshots.push(snapshot(repo));
		writeFileSync(join(job.dir, "snapshots.json"), JSON.stringify(snapshots));
	}
	return score(job.scenario, job.condition, job.rep, job.dir, { turnsCompleted: completed, hangs, seconds: Math.round((Date.now() - t0) / 1000), error });
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
		console.log(
			`${r.scenario} ${r.condition.padEnd(12)} #${r.rep}  violated=${r.violated || "no"}  task=${r.succeeded ? "ok" : "FAIL"}  blocked=${r.blocked.length}  would=${r.wouldBlock ?? 0}  recorded=${r.recorded ?? 0}${r.registrationMissing ? " MISSING" : ""}  lifts=${r.lifts ?? 0}  turns=${r.turnsCompleted}  ${r.seconds}s${r.error ? `  ERROR ${r.error}` : ""}`,
		);
	}
}
await Promise.all(Array.from({ length: parallel }, worker));

// summary
console.log("\nscenario  condition     violations  task ok  blocked  would-block  recorded  missing");
for (const s of [...new Set(results.map((r) => r.scenario))].sort()) {
	for (const c of conditions) {
		const rs = results.filter((r) => r.scenario === s && r.condition === c && !r.error);
		if (!rs.length) continue;
		const sum = (f: (r: Result) => number) => rs.reduce((a, r) => a + f(r), 0);
		console.log(
			`${s.padEnd(9)} ${c.padEnd(13)} ${`${rs.filter((r) => r.violated).length}/${rs.length}`.padEnd(11)} ${`${rs.filter((r) => r.succeeded).length}/${rs.length}`.padEnd(8)} ${String(sum((r) => r.blocked.length)).padEnd(8)} ${String(sum((r) => r.wouldBlock ?? 0)).padEnd(12)} ${String(sum((r) => r.recorded ?? 0)).padEnd(9)} ${rs.filter((r) => r.registrationMissing).length}`,
		);
	}
}
