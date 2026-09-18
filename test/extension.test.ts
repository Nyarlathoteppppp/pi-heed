import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Answer, ChoiceAnswer, Judge, Question } from "../src/judge.ts";
import { type FakePi, setup, toolCall } from "./harness.ts";

const answer = (choice: string, p = 0.97, confidence = 0.9): ChoiceAnswer => ({ type: "choice", choice, probabilities: { [choice]: p }, confidence });

/** Fake judge for gate questions (key "q"); background understanding calls get no answers. */
function judgeOf(fn: (signal: AbortSignal, q: Question) => Promise<ChoiceAnswer>): Judge {
	return {
		name: "fake",
		decide: async (_s, qs, signal) => ("q" in qs ? { q: await fn(signal, qs.q) } : {}) as Record<string, Answer>,
	};
}

/** Full fake: answers every question via `fn(key, question)`. */
function fullJudge(fn: (key: string, q: Question) => Answer | undefined): Judge {
	return {
		name: "fake",
		decide: async (_s, qs) => Object.fromEntries(Object.entries(qs).flatMap(([k, q]) => { const a = fn(k, q); return a ? [[k, a]] : []; })),
	};
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
		assert.equal((await pi.emit("tool_call", toolCall("bash", { command: "curl -X POST https://api.prod/y" })))?.block, true);
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

describe("v0.2: exceptions, understanding, speculation", () => {
	it("a later scoped exception lets the rule-blocked call through", async () => {
		const judge = judgeOf(async (_s, q) => ("permitted" in (q as any).criteria ? answer("permitted", 1, 0.99) : answer("complies")));
		const { pi } = track(setup({ config: { mode: "enforce" }, judge }));
		await pi.user("Don't modify any files.");
		await pi.user("I changed my mind for notes.txt only: append 'reviewed' to it.");
		assert.equal(await pi.emit("tool_call", toolCall("bash", { command: "echo reviewed >> notes.txt" })), undefined);
		assert.equal(pi.logs("gate")[0].exception.choice, "permitted");
	});

	it("no later message means no exception check and a block", async () => {
		let asked = 0;
		const { pi } = track(setup({ config: { mode: "enforce" }, judge: judgeOf(async () => (asked++, answer("permitted", 1, 1))) }));
		await pi.user("Don't modify any files.");
		assert.equal((await pi.emit("tool_call", toolCall("write", { path: "a" })))?.block, true);
		assert.equal(asked, 0);
	});

	it("background understanding adds a paraphrased constraint and drops a fake one", async () => {
		const judge = fullJudge((k) => (k === "set_read_only" ? { type: "noul", noul: 0.95 } : k.startsWith("real_") ? { type: "noul", noul: 0.02 } : { type: "noul", noul: 0.01 }));
		const { pi, heed } = track(setup({ config: { mode: "enforce" }, judge }));
		await pi.user("只看不改。Don't forget to add tests later.");
		await heed.settled();
		assert.deepEqual(heed.ledger.active().map((c) => [c.kind, c.by]), [["read_only", "jev"]]);
		assert.equal((await pi.emit("tool_call", toolCall("edit", { path: "a.ts" })))?.block, true);

		// persisted: a fresh instance rebuilds the Jev-derived state without calling Jev
		const again = setup({ judge: null });
		again.pi.entries = pi.entries;
		await again.pi.emit("session_start", { reason: "resume" });
		assert.deepEqual(again.heed.ledger.active().map((c) => c.kind), ["read_only"]);
	});

	it("a tool call that beats understanding waits for it", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const judge: Judge = { name: "slow", decide: async (_s, qs) => (await gate, ("set_read_only" in qs ? { set_read_only: { type: "noul", noul: 0.99 } } : {}) as Record<string, Answer>) };
		const { pi } = track(setup({ config: { mode: "enforce" }, judge }));
		await pi.user("hands off the code please");
		const call = pi.emit("tool_call", toolCall("edit", { path: "a.ts" }));
		release();
		assert.equal((await call)?.block, true);
	});

	it("pre-judges while streaming, so tool_call does not wait", async () => {
		let calls = 0;
		const { pi } = track(setup({ config: { mode: "enforce" }, judge: judgeOf(async () => (calls++, answer("violates"))) }));
		await pi.user("Never call the production API");
		const tc = toolCall("bash", { command: "curl -d x https://prod" });
		await pi.emit("message_update", { assistantMessageEvent: { type: "toolcall_end", toolCall: { id: tc.toolCallId, name: tc.toolName, arguments: tc.input } } });
		await new Promise((r) => setTimeout(r, 5));
		const r = await pi.emit("tool_call", tc);
		assert.equal(r?.block, true);
		assert.equal(calls, 1);
		assert.equal(pi.logs("gate")[0].prejudged, true);
	});

	it("re-judges when another extension patched the input", async () => {
		const seen: string[] = [];
		const { pi } = track(setup({ config: { mode: "enforce" }, judge: judgeOf(async () => answer("complies")) }));
		const orig = (pi as any).api;
		await pi.user("Never call the production API");
		const tc = toolCall("bash", { command: "curl -d x https://staging" });
		await pi.emit("message_update", { assistantMessageEvent: { type: "toolcall_end", toolCall: { id: tc.toolCallId, name: "bash", arguments: { command: "curl -d x https://staging" } } } });
		const patched = { ...tc, input: { command: "curl -d x https://prod" } };
		await pi.emit("tool_call", patched);
		seen.push(String(pi.logs("gate")[0].prejudged));
		assert.deepEqual(seen, ["false"]);
		void orig;
	});

	it("identical calls are judged once (memo)", async () => {
		let calls = 0;
		const { pi } = track(setup({ config: { mode: "shadow" }, judge: judgeOf(async () => (calls++, answer("complies"))) }));
		await pi.user("Never call the production API");
		for (let i = 0; i < 3; i++) await pi.emit("tool_call", toolCall("bash", { command: "curl -d x https://h" }));
		assert.equal(calls, 1);
	});

	it("constraints said while off are picked up when switched on", async () => {
		const { pi, heed } = track(setup({ config: { mode: "off" } }));
		await pi.user("Don't modify any files.");
		assert.equal(heed.ledger.active().length, 0);
		await pi.command("/heed mode enforce");
		assert.equal(heed.ledger.active().length, 1);
	});
});
