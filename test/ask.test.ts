// Before a block, the human is asked: block it, allow it once, or allow it and drop the rule (stale rules are hard to
// remove from the model's side). No UI, no answer, Esc or a timeout: the block stands.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakePi, setup, toolCall } from "./harness.ts";

function ledger(env: Record<string, string> = {}) {
	return setup({ judge: null, env: { PI_HEED_MODE: "enforce", PI_HEED_PIPELINE: "ledger", ...env } } as never);
}
const edit = (path: string) => toolCall("edit", { path, edits: [{ oldText: "a", newText: "b" }] });
const gate = (pi: FakePi, call: ReturnType<typeof toolCall>) => pi.emit("tool_call", call);

async function withRule(env: Record<string, string> = {}) {
	const s = ledger(env);
	await s.pi.user("别动测试");
	await s.pi.callTool("heed_record", { quote: "别动测试", effect: "deny", action: "modify", target: "tests", scope: "session" });
	return s;
}

describe("ask the human before blocking", () => {
	it("the dialog shows the call and the rule, with three choices", async () => {
		const { pi } = await withRule();
		const seen: Array<{ title: string; options: string[]; timeout?: number }> = [];
		pi.dialog = async (title, options, opts) => {
			seen.push({ title, options, timeout: opts?.timeout });
			return undefined;
		};
		const r = await gate(pi, edit("test/a.test.ts"));
		assert.equal(r?.block, true, "no answer: blocked");
		assert.match(seen[0].title, /test\/a\.test\.ts/);
		assert.match(seen[0].title, /p1 "别动测试"/);
		assert.deepEqual(seen[0].options, ["Block it (tell the agent)", "Allow this call once", "Allow, and drop rule p1"]);
		assert.equal(seen[0].timeout, 60_000);
	});

	it("allow once: this call goes through, the rule stays, no intervention is counted", async () => {
		const { pi, heed } = await withRule();
		pi.dialog = async (_t, o) => o[1];
		assert.equal(await gate(pi, edit("test/a.test.ts")), undefined);
		assert.equal(heed.engine.get("p1")!.status, "active");
		assert.equal(heed.interventions, 0);
		assert.match(pi.logs("gate").at(-1).note, /user allowed once/);
		pi.dialog = async (_t, o) => o[0];
		assert.equal((await gate(pi, edit("test/a.test.ts")))?.block, true, "asked again next time");
	});

	it("allow and drop: the rule ends, persisted, and later calls are not asked about", async () => {
		const { pi, heed } = await withRule();
		let asked = 0;
		pi.dialog = async (_t, o) => (asked++, o[2]);
		assert.equal(await gate(pi, edit("test/a.test.ts")), undefined);
		assert.equal(heed.engine.get("p1")!.status, "superseded");
		assert.match(heed.engine.get("p1")!.provenance.endReason!, /dropped by the user/);
		assert.equal(await gate(pi, edit("test/b.test.ts")), undefined);
		assert.equal(asked, 1);
		await pi.emit("session_start");
		assert.equal(heed.engine.get("p1")!.status, "superseded", "survives a rebuild");
	});

	it("block: the model gets the usual reason", async () => {
		const { pi } = await withRule();
		pi.dialog = async (_t, o) => o[0];
		const r = await gate(pi, edit("test/a.test.ts"));
		assert.match(r.reason, /\[pi-heed\].*heed_lift/);
	});

	it("a dialog that fails is a block", async () => {
		const { pi } = await withRule();
		pi.dialog = async () => {
			throw new Error("ui gone");
		};
		assert.equal((await gate(pi, edit("test/a.test.ts")))?.block, true);
	});

	it("PI_HEED_ASK=0 never asks; a number sets the timeout", async () => {
		const off = await withRule({ PI_HEED_ASK: "0" });
		let asked = false;
		off.pi.dialog = async (_t, o) => ((asked = true), o[1]);
		assert.equal((await gate(off.pi, edit("test/a.test.ts")))?.block, true);
		assert.equal(asked, false);
		const on = await withRule({ PI_HEED_ASK: "15000" });
		let timeout: number | undefined;
		on.pi.dialog = async (_t, o, opts) => ((timeout = opts?.timeout), o[0]);
		await gate(on.pi, edit("test/a.test.ts"));
		assert.equal(timeout, 15000);
	});

	it("shadow mode never asks (it never blocks)", async () => {
		const { pi } = await withRule({ PI_HEED_MODE: "shadow" });
		let asked = false;
		pi.dialog = async () => ((asked = true), undefined);
		assert.equal(await gate(pi, edit("test/a.test.ts")), undefined);
		await pi.flush();
		assert.equal(asked, false);
	});

	it("a free-text verdict has no single rule to drop: two choices", async () => {
		const judge = {
			name: "fake",
			decide: async (_s: unknown, qs: Record<string, unknown>) =>
				Object.fromEntries(Object.keys(qs).map((k) => [k, { type: "choice", choice: k === "q" ? "violates" : "unclear", probabilities: { violates: 0.97, unclear: 0.9 }, confidence: 0.95 }])),
		};
		const { pi } = setup({ judge, env: { PI_HEED_MODE: "enforce", PI_HEED_PIPELINE: "ledger" } } as never);
		await pi.user("Never call the production API.");
		await pi.callTool("heed_record", { quote: "Never call the production API", effect: "deny", action: "custom", text: "calling the production API", scope: "session" });
		let options: string[] = [];
		pi.dialog = async (_t, o) => ((options = o), o[1]);
		assert.equal(await gate(pi, toolCall("bash", { command: "curl https://api.prod.example.com" })), undefined);
		assert.deepEqual(options, ["Block it (tell the agent)", "Allow this call once"]);
	});
});
