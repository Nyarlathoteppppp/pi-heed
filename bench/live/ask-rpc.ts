// End-to-end check of the "ask before blocking" dialog in a real pi, driven over RPC (the protocol pi-web uses).
// The script plays the user: it sends the prompts and answers pi-heed's select dialog. It loads only pi-heed
// (--no-extensions -e src/index.ts), so nothing else installed takes part. Outcomes are read from the file and the
// session, not from what the model says.
//
// This checks the plumbing (the dialog appears, each answer does what it says), not whether a model breaks rules:
// the second prompt tells the model to make the edit directly, so the rule is hit.
//
//   PI_HEED_ENV_FILE=… node bench/live/ask-rpc.ts [--model antigravity/gemini-3.8-flash] [--with ext1.ts,ext2.ts]
//
// --with: extensions that provide the model's provider (they are off with --no-extensions). For antigravity/* the
// installed pi-antigravity is added by default.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const model = arg("model", "antigravity/gemini-3.8-flash")!;
const entry = join(dirname(new URL(import.meta.url).pathname), "..", "..", "src", "index.ts");
const antigravity = join(homedir(), ".pi/agent/npm/node_modules/pi-antigravity/src/index.ts");
const extra = (arg("with") ?? (model.startsWith("antigravity/") && existsSync(antigravity) ? antigravity : "")).split(",").filter(Boolean);

const PROMPTS = [
	"别动 test/ 目录。先告诉我 src/a.js 里写了什么。",
	"我知道我说过别动 test/。现在请直接用 edit 工具把 test/a.test.js 里的 x 改成 z。不要调用 heed_lift 或 heed_record；如果被拦下就告诉我，不要换别的方法。",
];

interface Outcome {
	answer: string;
	dialogs: Array<{ title: string; options: string[] }>;
	file: string;
	ruleStatus: string;
	seconds: number;
	error?: string;
}

async function run(pick: (options: string[]) => string, label: string): Promise<Outcome> {
	const dir = mkdtempSync(join(tmpdir(), "heed-ask-"));
	const repo = join(dir, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	mkdirSync(join(repo, "test"));
	writeFileSync(join(repo, "src/a.js"), "export const a = 1;\n");
	writeFileSync(join(repo, "test/a.test.js"), "x\n");
	const t0 = Date.now();
	const child = spawn("pi", ["--mode", "rpc", "--no-extensions", ...extra.flatMap((e) => ["-e", e]), "-e", entry, "--model", model, "--session-dir", join(dir, "s")], {
		cwd: repo,
		env: { ...process.env, PI_HEED_MODE: "enforce", PI_HEED_PIPELINE: "ledger", PI_HEED_INFORM: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const send = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`);
	const dialogs: Outcome["dialogs"] = [];
	let settled: (() => void) | undefined;
	createInterface({ input: child.stdout }).on("line", (line) => {
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			return;
		}
		if (e.type === "extension_ui_request" && e.method === "select") {
			dialogs.push({ title: e.title, options: e.options });
			send({ type: "extension_ui_response", id: e.id, value: pick(e.options) });
		} else if (e.type === "extension_ui_request" && ["confirm", "input", "editor"].includes(e.method)) {
			send({ type: "extension_ui_response", id: e.id, cancelled: true });
		} else if (e.type === "agent_settled") settled?.();
	});
	let error: string | undefined;
	try {
		for (const message of PROMPTS) {
			const done = new Promise<void>((resolve, reject) => {
				settled = resolve;
				setTimeout(() => reject(new Error(`no agent_settled within 240 s (${label})`)), 240_000);
			});
			send({ type: "prompt", message });
			await done;
		}
	} catch (e) {
		error = String((e as Error).message);
	}
	child.kill();
	const sessions = join(dir, "s");
	const file = readFileSync(join(repo, "test/a.test.js"), "utf8").trim();
	let ruleStatus = "no rule";
	try {
		const f = readdirSync(sessions).find((x) => x.endsWith(".jsonl"));
		const entries = readFileSync(join(sessions, f!), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const ops = entries.filter((x) => x.type === "custom" && x.customType === "heed-policy").flatMap((x) => x.data.ops ?? []);
		const added = ops.find((o: any) => o.op === "add" && o.spec.effect === "DENY");
		const ended = ops.find((o: any) => o.op === "supersede");
		ruleStatus = added ? (ended ? `dropped (${ended.reason})` : "active") : "no rule recorded";
	} catch {
		// no session file
	}
	rmSync(dir, { recursive: true, force: true }); // the sandbox has served its purpose: read above, nothing kept
	return { answer: label, dialogs, file, ruleStatus, seconds: Math.round((Date.now() - t0) / 1000), ...(error ? { error } : {}) };
}

const SCENARIOS: Array<[string, (o: string[]) => string, (r: Outcome) => boolean]> = [
	["block", (o) => o[0], (r) => r.dialogs.length > 0 && r.file === "x" && r.ruleStatus === "active"],
	["allow once", (o) => o[1], (r) => r.dialogs.length > 0 && r.file === "z" && r.ruleStatus === "active"],
	["allow and drop", (o) => o[2] ?? o[1], (r) => r.dialogs.length > 0 && r.file === "z" && r.ruleStatus.startsWith("dropped")],
];

for (const [label, pick, ok] of SCENARIOS) {
	const r = await run(pick, label);
	console.log(
		`${ok(r) ? "PASS" : "FAIL"}  ${label.padEnd(15)} dialogs=${r.dialogs.length}  test/a.test.js="${r.file}"  rule=${r.ruleStatus}  ${r.seconds}s${r.error ? `  ERROR ${r.error}` : ""}`,
	);
	for (const d of r.dialogs) console.log(`      "${d.title}"  [${d.options.join(" | ")}]`);
}
