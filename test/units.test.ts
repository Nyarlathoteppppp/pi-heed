import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "../src/actions.ts";
import { pathMatches, PolicyEngine } from "../src/policy.ts";
import { parseMessage } from "../src/rules.ts";
import { kinds as kindsOf } from "./harness.ts";
import { ask, JevJudge } from "../src/judge.ts";
import { errorSignature, RepeatTracker } from "../src/repeat.ts";

/** Feeds messages through the parser into a fresh engine, like the extension does. */
function ledger(...messages: string[]): PolicyEngine {
	const e = new PolicyEngine();
	messages.forEach((m, i) => parseMessage(m, i).forEach((op) => e.apply(op)));
	return e;
}
const kinds = (text: string) => kindsOf(ledger(text));

describe("constraint extraction", () => {
	const cases: Array<[string, string[]]> = [
		["Please review this PR. Don't modify any files.", ["read_only"]],
		["This is a read-only audit", ["read_only"]],
		["先帮我分析一下，不要改代码", ["read_only"]],
		["只读模式，看看这个 bug", ["read_only"]],
		["Fix the bug but don't touch the tests", ["no_tests"]],
		["修一下这个问题，别动测试", ["no_tests"]],
		["No new dependencies please", ["no_deps"]],
		["不要引入新的依赖", ["no_deps"]],
		["Don't edit src/config.ts", ["protect_path"]],
		["别改 package.json", ["protect_path"]],
		["Never call the production API", ["custom"]],
		["Don't worry about performance", []],
		["Refactor the parser", []],
	];
	for (const [text, expected] of cases) it(text, () => assert.deepEqual(kinds(text), expected));

	it("revokes read-only, keeps a later constraint in the same message", () => {
		const l = ledger("Don't modify any files yet.", "OK, you can edit now. But don't touch the tests.");
		assert.equal(l.history().length, 1);
		assert.deepEqual(kindsOf(l), ["no_tests"]);
	});

	it("does not treat 不可以改 as permission", () => {
		assert.deepEqual(kindsOf(ledger("不要改代码", "还是不可以改")), ["read_only"]);
	});

	it("中文撤销", () => {
		assert.deepEqual(ledger("只读，先别改文件", "好，现在可以改了").active(), []);
	});
});

describe("side-effect classification", () => {
	const bash = (command: string) => classify("bash", { command });
	it("read-only shell commands", () => {
		for (const c of ["ls -la", "cat a.ts | grep x", "npm test", "git status", "git diff HEAD~1", "npm test 2>&1 | tail", "make build > /dev/null"]) {
			assert.equal(bash(c).mutates, false, c);
		}
	});
	it("mutating shell commands", () => {
		for (const c of ["echo hi > out.txt", "sed -i '' s/a/b/ f.ts", "rm -rf dist", "git commit -m x", "npm install", "mv a b"]) {
			assert.equal(bash(c).mutates, true, c);
		}
	});
	it("dependency installs", () => {
		assert.equal(bash("npm install lodash").installsDeps, true);
		assert.equal(bash("pnpm add -D vitest").installsDeps, true);
		assert.equal(bash("pip install requests").installsDeps, true);
		assert.equal(bash("npm install").installsDeps, false);
		assert.equal(bash("pip install -r requirements.txt").installsDeps, false);
	});
	it("paths from bash", () => {
		assert.deepEqual(bash("rm test/foo.test.ts").paths, ["test/foo.test.ts"]);
	});
	it("edit/write/read tools", () => {
		assert.equal(classify("edit", { path: "a.ts" }).mutates, true);
		assert.equal(classify("read", { path: "a.ts" }).mutates, false);
		assert.equal(classify("mcp_call", {}).effect, "unknown");
	});
});

describe("repeat tracker", () => {
	const out = "FAIL src/a.test.ts\n  Error: expected 3 to be 4 (12ms)\nCommand exited with code 1";
	it("notes the second identical failure once", () => {
		const r = new RepeatTracker(2);
		assert.equal(r.recordFailure("npm test", out), undefined);
		assert.match(r.recordFailure("npm  test", out)!.note, /failed 2 times/);
		assert.equal(r.recordFailure("npm test", out), undefined);
	});
	it("a file change in between resets", () => {
		const r = new RepeatTracker(2);
		r.recordFailure("npm test", out);
		r.markChange();
		assert.equal(r.recordFailure("npm test", out), undefined);
	});
	it("a different error is not a repeat", () => {
		const r = new RepeatTracker(2);
		r.recordFailure("npm test", out);
		assert.equal(r.recordFailure("npm test", "Error: cannot find module x"), undefined);
	});
	it("masks volatile tokens", () => {
		assert.equal(errorSignature("Error at line 12 (30ms)"), errorSignature("Error at line 99 (4ms)"));
	});
});

describe("JevJudge", () => {
	const transport = { url: "https://openrouter.ai/api/alpha/decisions", model: "~typesafe/jev-latest", key: "k" };
	const q = { q: { type: "choice" as const, instructions: "?", criteria: { violates: "", complies: "", insufficient: "" } } };
	const fake = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

	it("parses a choice answer", async () => {
		const j = new JevJudge(transport, fake({ answers: { q: { type: "choice", choice: "complies", probabilities: { complies: 0.9 }, confidence: 0.7 } } }));
		const a = await j.decide({}, q, new AbortController().signal);
		assert.equal((a.q as any).choice, "complies");
	});
	it("rejects an option it did not offer", async () => {
		const j = new JevJudge(transport, fake({ answers: { q: { choice: "maybe", probabilities: {}, confidence: 1 } } }));
		await assert.rejects(j.decide({}, q, new AbortController().signal), /malformed/);
	});
	it("throws on http errors", async () => {
		const j = new JevJudge(transport, fake({}, 429));
		await assert.rejects(j.decide({}, q, new AbortController().signal), /429/);
	});
});

describe("pathMatches", () => {
	it("matches on segment boundaries only", () => {
		assert.equal(pathMatches("src/a.ts", "a.ts"), true);
		assert.equal(pathMatches("src/data.ts", "a.ts"), false);
		assert.equal(pathMatches("./package.json", "package.json"), true);
		assert.equal(pathMatches("src/legacy/x.ts", "src/legacy/"), true);
		assert.equal(pathMatches("lib/src/legacy/x.ts", "src/legacy"), true);
		assert.equal(pathMatches("src/legacyish.ts", "src/legacy"), false);
	});
});

describe("rules: paths at the end of a sentence", () => {
	it("drops trailing punctuation", () => {
		const ops = parseMessage("For this fix only, you may touch src/auth/token.ts.", 0);
		assert.equal((ops[0] as any).spec.resource, "src/auth/token.ts");
	});
});

describe("rules: 别 is not always a prohibition (real session)", () => {
	const kindsOfText = (t: string) => kindsOf(ledger(t));
	it("别人 / 区别 / 特别 are not prohibitions", () => {
		assert.deepEqual(kindsOfText("刚才别人问风雪驱动炸了为什么她不回复"), []);
		assert.deepEqual(kindsOfText("这两个方案有什么区别"), []);
		assert.deepEqual(kindsOfText("这个特别重要，看一下"), []);
	});
	it("别 before a verb still is", () => {
		assert.deepEqual(kindsOfText("别动测试"), ["no_tests"]);
		assert.deepEqual(kindsOfText("别改 package.json"), ["protect_path"]);
	});
});

describe("interpreter-aware shell classification (real session)", () => {
	const cases: Array<[string, boolean]> = [
		[`ssh qqbot-server 'python3 - <<"PY"\nimport json\nprint(json.dumps({"a": 1}))\nPY'`, false],
		[`python3 - <<'PY'\nimport os, json\nif x > 3: print(x)\nPY`, false],
		[`node -e "console.log(1 > 0)"`, false],
		[`python3 -c "print(2 > 1)"`, false],
		[`python3 - <<'PY'\nopen('out.txt', 'w').write('x')\nPY`, true],
		[`node -e "require('fs').writeFileSync('a.txt','x')"`, true],
		[`python3 -c "import shutil; shutil.rmtree('build')"`, true],
		[`python3 - <<'PY'\nimport requests\nrequests.post('https://x', json={})\nPY`, true],
		[`python3 script.py > out.txt`, true],
		[`bash -c "echo x > f.txt"`, true],
		[`ssh host 'rm -rf /srv/app'`, true],
	];
	for (const [command, mutates] of cases) it(command.replace(/\n/g, "⏎").slice(0, 60), () => assert.equal(classify("bash", { command }).mutates, mutates));
});

describe("JevJudge: retries and answer validation (borrowed from thruwire/foreman)", () => {
	const transport = { url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", key: "k" };
	const noulQ = { q: { type: "noul" as const, instructions: "?" } };
	const scripted = (responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) => {
		let i = 0;
		const fn = (async () => {
			const r = responses[Math.min(i++, responses.length - 1)];
			return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
		}) as unknown as typeof fetch;
		return { fn, calls: () => i };
	};

	it("retries a 429 and then succeeds", async () => {
		const f = scripted([{ status: 429, headers: { "retry-after": "0" } }, { status: 200, body: { answers: { q: { noul: 0.7 } } } }]);
		const a = await new JevJudge(transport, f.fn).decide({}, noulQ, new AbortController().signal);
		assert.equal((a.q as any).noul, 0.7);
		assert.equal(f.calls(), 2);
	});

	it("gives up after two retries on 5xx", async () => {
		const f = scripted([{ status: 503 }]);
		await assert.rejects(new JevJudge(transport, f.fn).decide({}, noulQ, new AbortController().signal), /503/);
		assert.equal(f.calls(), 3);
	});

	it("does not retry a 4xx that isn't 429", async () => {
		const f = scripted([{ status: 401 }]);
		await assert.rejects(new JevJudge(transport, f.fn).decide({}, noulQ, new AbortController().signal), /401/);
		assert.equal(f.calls(), 1);
	});

	it("a Retry-After beyond the deadline fails open via the caller's timeout", async () => {
		const f = scripted([{ status: 429, headers: { "retry-after": "30" } }, { status: 200, body: { answers: { q: { noul: 0.7 } } } }]);
		const t0 = Date.now();
		const r = await ask(new JevJudge(transport, f.fn), {}, noulQ, 50);
		assert.equal(r.answers, undefined);
		assert.equal(r.error, "timeout");
		assert.ok(Date.now() - t0 < 1000);
	});

	it("clamps small overshoot and rejects non-finite values", async () => {
		const ok = scripted([{ status: 200, body: { answers: { q: { noul: 1.0000001 } } } }]);
		assert.equal(((await new JevJudge(transport, ok.fn).decide({}, noulQ, new AbortController().signal)).q as any).noul, 1);
		const bad = scripted([{ status: 200, body: { answers: { q: { noul: "NaN" } } } }]);
		await assert.rejects(new JevJudge(transport, bad.fn).decide({}, noulQ, new AbortController().signal), /malformed/);
	});
});

describe("rules: a pasted task spec is not a list of tool bans (real session, E15)", () => {
	const spec = [
		"基于当前 pipeline 做最小必要优化。不要继续新增 classifier，不要大重构。",
		"用户纠正旧理解后，不能只改 repair 结果，所有依赖旧状态的结果都要检查失效。",
		"* speaker_relation / message_relation 不得残留旧绑定",
		"repair target 不要默认最后一句。",
		"不要做复杂 dependency graph，只实现轻量 invalidation/recompute。",
		"不要再混用 none / unresolved / null / jev_unavailable。",
		"不要增加更多维度，不让 Jev 改写回复。",
	].join("\n\n");
	it("yields no file, dependency or read-only policy (free-text ones are left to Jev's guidance check)", () => {
		const nonCustom = parseMessage(spec, 0).filter((o: any) => o.op !== "add" || o.spec.action !== "custom");
		assert.deepEqual(nonCustom, []);
	});
	it("real bans next to it still parse", () => {
		assert.deepEqual(kinds("所有依赖旧状态的结果都要检查，但别改 config.yaml"), ["protect_path"]);
		assert.deepEqual(kinds("不要引入新的依赖"), ["no_deps"]);
		assert.deepEqual(kinds("classifier 目录不能改"), ["protect_path"]);
	});
});

describe("settings file for pi started outside a shell", () => {
	it("reads ~/.pi/agent/pi-heed.json-style files and ignores broken ones", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const { readSettingsFile } = await import("../src/index.ts");
		const d = mkdtempSync(join(tmpdir(), "heed-"));
		writeFileSync(join(d, "ok.json"), JSON.stringify({ envFile: "~/x/.env", mode: "enforce" }));
		writeFileSync(join(d, "bad.json"), "{not json");
		assert.deepEqual(readSettingsFile(join(d, "ok.json")), { envFile: "~/x/.env", mode: "enforce" });
		assert.deepEqual(readSettingsFile(join(d, "bad.json")), {});
		assert.deepEqual(readSettingsFile(join(d, "missing.json")), {});
	});
});
