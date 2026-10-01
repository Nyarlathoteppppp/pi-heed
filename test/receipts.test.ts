import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setup, toolCall, type FakePi } from "./harness.ts";

const deny = { quote: "别改 package.json", effect: "deny", action: "modify", target: "package.json", scope: "session" };
const once = { quote: "这一次可以改 package.json", effect: "allow", action: "modify", target: "package.json", scope: "once" };
const next = async (pi: FakePi, text: string) => { await pi.emit("agent_end"); await pi.user(text); };
const edit = async (pi: FakePi) => !!(await pi.emit("tool_call", toolCall("edit", { path: "package.json", oldText: "a", newText: "b" })))?.block;
async function permitted() {
	const s = setup({ judge: null, env: { PI_HEED_MODE: "enforce", PI_HEED_PIPELINE: "ledger" } });
	await s.pi.user("别改 package.json");
	await s.pi.callTool("heed_record", deny);
	await next(s.pi, "这一次可以改 package.json，加个 lint 脚本");
	await s.pi.callTool("heed_record", once);
	return s;
}

describe("permission receipts cannot be replayed", () => {
	it("the tests resource also retains a once receipt's consumption", async () => {
		const { pi } = setup({ judge: null, env: { PI_HEED_MODE: "enforce", PI_HEED_PIPELINE: "ledger" } });
		await pi.user("别动测试");
		await pi.callTool("heed_record", { quote: "别动测试", effect: "deny", action: "modify", target: "tests", scope: "session" });
		await next(pi, "这一次测试可以改");
		const permission = { quote: "这一次测试可以改", effect: "allow", action: "modify", target: "tests", scope: "once" };
		await pi.callTool("heed_record", permission);
		assert.equal(await pi.emit("tool_call", toolCall("edit", {path: "test/a.test.ts"})), undefined);
		assert.equal((await pi.callTool("heed_record", permission)).details?.ok, false);
		assert.equal((await pi.emit("tool_call", toolCall("edit", {path: "test/a.test.ts"})))?.block, true);
	});

	it("repeating an active once permission does not create a second use", async () => {
		const { pi } = await permitted();
		await pi.callTool("heed_record", once);
		assert.equal(await edit(pi), false);
		assert.equal(await edit(pi), true);
	});

	it("a consumed once receipt stays consumed after replay, even with a different quote span or scope", async () => {
		const { pi } = await permitted();
		assert.equal(await edit(pi), false);
		await pi.emit("session_start");
		for (const params of [once, { ...once, quote: "可以改 package.json" }, { ...once, scope: "run" }]) {
			const r = await pi.callTool("heed_record", params);
			assert.equal(r.details?.ok, false);
			assert.match(r.text, /used once/);
			assert.equal(await edit(pi), true);
		}
	});

	it("an expired run permission cannot be revived in a later run", async () => {
		const { pi } = await permitted();
		assert.equal(await edit(pi), false);
		await next(pi, "这一轮可以改 package.json");
		const run = { ...once, quote: "这一轮可以改 package.json", scope: "run" };
		await pi.callTool("heed_record", run);
		await next(pi, "继续检查");
		assert.equal((await pi.callTool("heed_record", run)).details?.ok, false);
		assert.equal(await edit(pi), true);
	});

	it("a newer denial invalidates an older receipt, including a permission not previously recorded", async () => {
		for (const record of [true, false]) {
			const { pi } = setup({ judge: null, env: { PI_HEED_MODE: "enforce", PI_HEED_PIPELINE: "ledger" } });
			await pi.user("这一次可以改 package.json");
			if (record) await pi.callTool("heed_record", once);
			await next(pi, "别改 package.json，刚才的许可取消");
			await pi.callTool("heed_record", deny);
			assert.equal((await pi.callTool("heed_record", once)).details?.ok, false);
			assert.equal(await edit(pi), true);
		}
	});

	it("changing an overlapping target cannot refill a consumed receipt", async () => {
		const { pi } = await permitted();
		assert.equal(await edit(pi), false);
		for (const target of ["./package.json", "*"]) {
			assert.equal((await pi.callTool("heed_record", { ...once, target })).details?.ok, false);
			assert.equal(await edit(pi), true);
		}
	});

	it("the user can grant a new use with the same words in a newer message", async () => {
		const { pi } = await permitted();
		assert.equal(await edit(pi), false);
		await next(pi, "别改 package.json");
		await pi.callTool("heed_record", deny);
		await next(pi, "这一次可以改 package.json");
		assert.equal((await pi.callTool("heed_record", once)).details?.ok, true);
		assert.equal(await edit(pi), false);
		assert.equal(await edit(pi), true);
	});
});
