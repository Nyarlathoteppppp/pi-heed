import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "../src/actions.ts";
import { pathMatches, PolicyEngine } from "../src/policy.ts";
import { parseMessage } from "../src/rules.ts";
import { kinds as kindsOf } from "./harness.ts";
import { JevJudge } from "../src/judge.ts";
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
