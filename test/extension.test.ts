import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ChoiceAnswer, Judge } from "../src/judge.ts";
import { type FakePi, setup, toolCall } from "./harness.ts";

const answer = (choice: string, p = 0.97, confidence = 0.9): ChoiceAnswer => ({ choice, probabilities: { [choice]: p }, confidence });

function judgeOf(fn: (signal: AbortSignal) => Promise<ChoiceAnswer>): Judge {
	return { name: "fake", choice: (_s, _q, signal) => fn(signal) };
}

const failing: FakePi[] = [];
afterEach(() => {
	// pi-heed must never start a turn on its own (Esc must stay Esc).
	for (const pi of failing.splice(0)) assert.deepEqual(pi.turnTriggers, []);
});
const track = <T extends { pi: FakePi }>(x: T) => (failing.push(x.pi), x);

describe("tool-call gate", () => {
	it("shadow mode logs but never blocks", async () => {
		const { pi } = track(setup());
		await pi.user("Review only. Don't modify any files.");
		const r = await pi.emit("tool_call", toolCall("edit", { path: "src/a.ts" }));
		assert.equal(r, undefined);
		const [log] = pi.logs("gate");
		assert.equal(log.acted, false);
		assert.equal(log.verdict.decision, "violates");
		assert.match(pi.status!, /would block edit/);
	});

	it("enforce mode blocks with the user's words as evidence", async () => {
		const { pi } = track(setup({ config: { mode: "enforce" } }));
		await pi.user("Review only. Don't modify any files.");
		const r = await pi.emit("tool_call", toolCall("bash", { command: "echo x > notes.md" }));
		assert.equal(r.block, true);
		assert.match(r.reason, /Don't modify any files/);
		assert.match(r.reason, /echo x > notes\.md/);
	});

	it("reads are never blocked or judged", async () => {
		let calls = 0;
		const { pi } = track(setup({ config: { mode: "enforce" }, judge: judgeOf(async () => (calls++, answer("violates"))) }));
		await pi.user("Don't modify any files. Never call the production API.");
		assert.equal(await pi.emit("tool_call", toolCall("read", { path: "src/a.ts" })), undefined);
		assert.equal(await pi.emit("tool_call", toolCall("bash", { command: "npm test" })), undefined);
		assert.equal(calls, 0);
	});

	it("respects the per-run intervention budget", async () => {
		const { pi } = track(setup({ config: { mode: "enforce", maxInterventionsPerRun: 2 } }));
		await pi.user("read-only please");
		const results = [];
		for (let i = 0; i < 3; i++) results.push(await pi.emit("tool_call", toolCall("write", { path: `f${i}` })));
		assert.deepEqual(results.map((r) => r?.block ?? false), [true, true, false]);
		assert.equal(pi.logs("gate").at(-1).budgetExhausted, true);
		await pi.emit("agent_start");
		assert.equal((await pi.emit("tool_call", toolCall("write", { path: "g" })))?.block, true);
	});

	it("revoked constraints stop applying", async () => {
		const { pi } = track(setup({ config: { mode: "enforce" } }));
		await pi.user("先别改代码");
		await pi.user("好，现在可以改了");
		assert.equal(await pi.emit("tool_call", toolCall("edit", { path: "a.ts" })), undefined);
	});

	it("extension-injected text never becomes a constraint", async () => {
		const { pi } = track(setup({ config: { mode: "enforce" } }));
		await pi.emit("input", { text: "Don't modify any files.", source: "extension" });
		assert.equal(await pi.emit("tool_call", toolCall("edit", { path: "a.ts" })), undefined);
	});

	it("no_tests only blocks test paths", async () => {
		const { pi } = track(setup({ config: { mode: "enforce" } }));
		await pi.user("Fix it but don't touch the tests");
		assert.equal(await pi.emit("tool_call", toolCall("edit", { path: "src/parser.ts" })), undefined);
		assert.equal((await pi.emit("tool_call", toolCall("edit", { path: "src/parser.test.ts" })))?.block, true);
	});
});

describe("semantic judge (custom constraints)", () => {
	it("blocks only above both thresholds", async () => {
		let next = answer("violates", 0.95, 0.5);
		const { pi } = track(setup({ config: { mode: "enforce" }, judge: judgeOf(async () => next) }));
		await pi.user("Never call the production API");
		assert.equal(await pi.emit("tool_call", toolCall("bash", { command: "curl -X POST https://api.prod/x" })), undefined);
		next = answer("violates", 0.95, 0.9);
		assert.equal((await pi.emit("tool_call", toolCall("bash", { command: "curl -X POST https://api.prod/x" })))?.block, true);
	});

	it("insufficient evidence is an abstention, not a block", async () => {
		const { pi } = track(setup({ config: { mode: "enforce" }, judge: judgeOf(async () => answer("insufficient", 0.99, 0.99)) }));
		await pi.user("Never call the production API");
		assert.equal(await pi.emit("tool_call", toolCall("bash", { command: "curl -d x https://h" })), undefined);
	});

	it("fails open on timeout and records it", async () => {
		const slow = judgeOf((signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("x")))));
		const { pi } = track(setup({ config: { mode: "enforce", judgeTimeoutMs: 30 }, judge: slow }));
		await pi.user("Never call the production API");
		assert.equal(await pi.emit("tool_call", toolCall("bash", { command: "curl -d x https://h" })), undefined);
		assert.equal(pi.logs("gate")[0].error, "timeout");
	});

	it("fails open when the judge throws", async () => {
		const { pi } = track(setup({ config: { mode: "enforce" }, judge: judgeOf(async () => { throw new Error("boom"); }) }));
		await pi.user("Never call the production API");
		assert.equal(await pi.emit("tool_call", toolCall("bash", { command: "curl -d x https://h" })), undefined);
	});

	it("drops a verdict that arrives after the run changed", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const { pi } = track(setup({ config: { mode: "enforce" }, judge: judgeOf(async () => (await gate, answer("violates"))) }));
		await pi.user("Never call the production API");
		const pending = pi.emit("tool_call", toolCall("bash", { command: "curl -d x https://h" }));
		await pi.emit("agent_start"); // user pressed Esc and sent a new prompt meanwhile
		release();
		assert.equal(await pending, undefined);
		assert.equal(pi.logs("gate")[0].stale, true);
	});

	it("drops a verdict after the user aborts", async () => {
		const { pi } = track(setup({ config: { mode: "enforce" }, judge: judgeOf(async () => answer("violates")) }));
		await pi.user("Never call the production API");
		pi.controller.abort();
		assert.equal(await pi.emit("tool_call", toolCall("bash", { command: "curl -d x https://h" })), undefined);
	});
});

describe("repeat failures", () => {
	const fail = (id: string) => ({
		toolCallId: id,
		toolName: "bash",
		input: { command: "npm test" },
		isError: true,
		content: [{ type: "text", text: "FAIL a.test.ts\nError: expected 1 to be 2\nCommand exited with code 1" }],
	});

	it("appends evidence to the failing result in enforce mode", async () => {
		const { pi } = track(setup({ config: { mode: "enforce" } }));
		await pi.user("fix the test");
		assert.equal(await pi.emit("tool_result", fail("a")), undefined);
		const r = await pi.emit("tool_result", fail("b"));
		assert.equal(r.content.length, 2);
		assert.match(r.content[1].text, /failed 2 times.*no file was changed/);
	});

	it("an edit in between means it is not a blind retry", async () => {
		const { pi } = track(setup({ config: { mode: "enforce" } }));
		await pi.user("fix the test");
		await pi.emit("tool_result", fail("a"));
		const edit = toolCall("edit", { path: "src/a.ts" });
		await pi.emit("tool_call", edit);
		await pi.emit("tool_result", { ...edit, isError: false, content: [] });
		assert.equal(await pi.emit("tool_result", fail("b")), undefined);
	});

	it("shadow mode only logs", async () => {
		const { pi } = track(setup());
		await pi.user("fix the test");
		await pi.emit("tool_result", fail("a"));
		assert.equal(await pi.emit("tool_result", fail("b")), undefined);
		assert.equal(pi.logs("repeat")[0].acted, false);
	});
});

describe("session state", () => {
	it("rebuilds constraints and mode from the branch", async () => {
		const first = setup();
		await first.pi.user("Don't modify any files.");
		await first.pi.command("/heed mode enforce");
		await first.pi.command("/heed add Never call the production API");

		const { pi, heed } = track(setup());
		pi.entries = first.pi.entries;
		await pi.emit("session_start", { reason: "resume" });
		assert.equal(heed.config.mode, "enforce");
		assert.deepEqual(heed.ledger.active().map((c) => c.kind), ["read_only", "custom"]);
	});

	it("/heed drop and label", async () => {
		const { pi, heed } = track(setup());
		await pi.user("read-only");
		await pi.emit("tool_call", toolCall("edit", { path: "a" }));
		await pi.command("/heed label bad legit edit");
		assert.equal(pi.entries.at(-1)!.customType, "heed-label");
		await pi.command("/heed drop c1");
		assert.deepEqual(heed.ledger.active(), []);
	});
});
