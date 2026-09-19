// The ledger pipeline: the main model records and lifts rules (heed_record / heed_lift) with the user's words as the
// receipt; pi-heed checks the receipt and enforces at tool-call time. Acceptance cases from the design review.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Answer, Judge, Question } from "../src/judge.ts";
import { describe as describePolicy } from "../src/policy.ts";
import { FakePi, setup, toolCall } from "./harness.ts";

type Asked = { key: string; q: Question; state: any };
/** A judge that answers per question key; records what it was asked. */
function fakeJudge(fn: (a: Asked) => Answer | undefined, log: Asked[] = []): Judge {
	return {
		name: "fake",
		decide: async (state, qs) =>
			Object.fromEntries(
				Object.entries(qs).flatMap(([key, q]) => {
					const a = { key, q, state };
					log.push(a);
					const r = fn(a);
					return r ? [[key, r]] : [];
				}),
			),
	};
}
const choice = (c: string, p = 0.97, confidence = 0.95): Answer => ({ type: "choice", choice: c, probabilities: { [c]: p }, confidence });

function ledger(judge: Judge | null = null, pipeline = "ledger", config = {}) {
	return setup({ judge, env: { PI_HEED_MODE: "enforce", PI_HEED_PIPELINE: pipeline }, config } as never);
}
async function next(pi: FakePi, text: string) {
	await pi.emit("agent_end");
	await pi.user(text);
}
const edit = (path: string, newText = "b") => toolCall("edit", { path, edits: [{ oldText: "a", newText }] });
async function blocked(pi: FakePi, call: ReturnType<typeof toolCall>) {
	return !!(await pi.emit("tool_call", call))?.block;
}
const active = (h: any) => h.engine.active().map((p: any) => describePolicy(p));

describe("ledger: recording", () => {
	it("records a rule with the user's words; pi-heed enforces it", async () => {
		const { pi, heed } = ledger();
		await pi.user("Fix the parser, but don't touch the tests.");
		assert.deepEqual(active(heed), [], "the ledger pipeline does not parse");
		const r = await pi.callTool("heed_record", { quote: "don't touch the tests", effect: "deny", action: "modify", target: "tests", scope: "session" });
		assert.match(r.text, /Recorded/);
		assert.equal(heed.engine.active()[0].provenance.by, "model");
		assert.equal(await blocked(pi, edit("test/parser.test.ts")), true);
		assert.equal(await blocked(pi, edit("src/parser.ts")), false);
	});

	it("rejects a quote the user never typed, and one only an extension injected", async () => {
		const { pi, heed } = ledger();
		await pi.injected("[GOAL] Do NOT push anything.");
		await pi.user("Look at the build.");
		const a = await pi.callTool("heed_record", { quote: "Do NOT push anything", effect: "deny", action: "git_push", scope: "session" });
		const b = await pi.callTool("heed_record", { quote: "never push", effect: "deny", action: "git_push", scope: "session" });
		assert.match(a.text, /Not recorded/);
		assert.match(b.text, /Not recorded/);
		assert.deepEqual(active(heed), []);
	});

	it("once is only for a permission; unless only for a restriction", async () => {
		const { pi } = ledger();
		await pi.user("Don't push, just this once.");
		assert.match((await pi.callTool("heed_record", { quote: "Don't push", effect: "deny", action: "git_push", scope: "once" })).text, /only for an allow/);
		assert.match((await pi.callTool("heed_record", { quote: "Don't push", effect: "allow", action: "git_push", scope: "run", unless: "x" })).text, /belongs on a deny/);
	});

	it("a glob target", async () => {
		const { pi } = ledger();
		await pi.user("不要动任何 markdown 文件");
		await pi.callTool("heed_record", { quote: "不要动任何 markdown 文件", effect: "deny", action: "modify", target: "*.md", scope: "session" });
		assert.equal(await blocked(pi, edit("docs/a.md")), true);
		assert.equal(await blocked(pi, edit("src/a.ts")), false);
	});

	it("pi-heed's own tools are never checked, even under read-only or a free-text rule", async () => {
		const judge = fakeJudge(() => choice("violates"));
		const { pi } = ledger(judge);
		await pi.user("Read-only. Never call the production API.");
		await pi.callTool("heed_record", { quote: "Read-only", effect: "deny", action: "modify", target: "*", scope: "session" });
		const r = await pi.callTool("heed_record", { quote: "Never call the production API", effect: "deny", action: "custom", text: "calling the production API", scope: "session" });
		assert.equal(r.blocked, false);
		assert.match((await pi.callTool("heed_lift", { id: "p1", quote: "Read-only" })).text, /Nothing lifted/);
	});
});

describe("ledger: temporary permissions keep the rule", () => {
	it("deny package.json → allow once → used → the ban holds again", async () => {
		const { pi, heed } = ledger();
		await pi.user("别改 package.json");
		await pi.callTool("heed_record", { quote: "别改 package.json", effect: "deny", action: "modify", target: "package.json", scope: "session" });
		await next(pi, "这一次可以改 package.json，加个 lint 脚本");
		await pi.callTool("heed_record", { quote: "这一次可以改 package.json", effect: "allow", action: "modify", target: "package.json", scope: "once" });
		assert.equal(await blocked(pi, edit("package.json")), false);
		assert.equal(await blocked(pi, edit("package.json")), true, "used once, the ban is back");
		assert.equal(heed.engine.get("p1")!.status, "active");
	});

	it("allow run ends with the request", async () => {
		const { pi } = ledger();
		await pi.user("No new dependencies.");
		await pi.callTool("heed_record", { quote: "No new dependencies", effect: "deny", action: "install_deps", scope: "session" });
		await next(pi, "For this request you can install packages.");
		await pi.callTool("heed_record", { quote: "For this request you can install packages", effect: "allow", action: "install_deps", scope: "run" });
		assert.equal(await blocked(pi, toolCall("bash", { command: "npm install zod" })), false);
		await next(pi, "continue");
		assert.equal(await blocked(pi, toolCall("bash", { command: "npm install zod" })), true);
	});
});

describe("ledger: lifting needs a newer receipt and Jev's agreement", () => {
	// Jev agrees only when the user's message is about the tests
	const liftJudge = (log: Asked[] = []) => fakeJudge((a) => (a.key === "q" && "rule_said" in a.state ? (/测试/.test(a.state.user_message) ? choice("takes_back") : choice("keeps")) : undefined), log);

	it("'README 改吧' does not lift the tests ban; '测试可以改了' does", async () => {
		const { pi, heed } = ledger(liftJudge());
		await pi.user("别动测试");
		await pi.callTool("heed_record", { quote: "别动测试", effect: "deny", action: "modify", target: "tests", scope: "session" });
		await next(pi, "README 改吧");
		assert.match((await pi.callTool("heed_lift", { id: "p1", quote: "README 改吧" })).text, /Not lifted/);
		assert.equal(await blocked(pi, edit("a.test.ts")), true);
		await next(pi, "现在测试可以改了");
		assert.match((await pi.callTool("heed_lift", { id: "p1", quote: "测试可以改了" })).text, /Lifted/);
		assert.equal(await blocked(pi, edit("a.test.ts")), false);
		assert.equal(heed.engine.get("p1")!.provenance.by, "model");
	});

	it("the receipt must be newer than the rule", async () => {
		const { pi } = ledger(liftJudge());
		await pi.user("别动测试，测试以后再说");
		await pi.callTool("heed_record", { quote: "别动测试", effect: "deny", action: "modify", target: "tests", scope: "session" });
		assert.match((await pi.callTool("heed_lift", { id: "p1", quote: "测试以后再说" })).text, /after rule p1/);
	});

	it("without a judge, lifting is left to the user (/heed drop)", async () => {
		const { pi } = ledger(null);
		await pi.user("别动测试");
		await pi.callTool("heed_record", { quote: "别动测试", effect: "deny", action: "modify", target: "tests", scope: "session" });
		await next(pi, "测试可以改了");
		assert.match((await pi.callTool("heed_lift", { id: "p1", quote: "测试可以改了" })).text, /heed drop p1/);
		await pi.command("/heed drop p1");
		assert.equal(await blocked(pi, edit("a.test.ts")), false);
	});

	it("a block tells the model how to lift or ask", async () => {
		const { pi } = ledger();
		await pi.user("Don't push.");
		await pi.callTool("heed_record", { quote: "Don't push", effect: "deny", action: "git_push", scope: "session" });
		const r = await pi.emit("tool_call", toolCall("bash", { command: "git push" }));
		assert.match(r.reason, /heed_lift/);
	});
});

describe("ledger: unless", () => {
	// excepted when the edit only swaps "teh" for "the"
	const typoJudge = (log: Asked[] = []) =>
		fakeJudge((a) => (a.key === "q" && "exception" in a.state ? (/"teh".*"the"|teh→the/.test(a.state.pending_tool_call.input) ? choice("excepted") : choice("not_excepted")) : undefined), log);
	const typoEdit = (path: string) => toolCall("edit", { path, edits: [{ oldText: "teh", newText: "the" }] });

	it("a typo fix passes, a logic change on the same path is blocked; each is judged on its content", async () => {
		const log: Asked[] = [];
		const { pi } = ledger(typoJudge(log));
		await pi.user("测试不要动，除非只是修 typo");
		await pi.callTool("heed_record", { quote: "测试不要动，除非只是修 typo", effect: "deny", action: "modify", target: "tests", scope: "session", unless: "只是修 typo" });
		assert.equal(await blocked(pi, typoEdit("test/a.test.ts")), false);
		assert.equal(await blocked(pi, edit("test/a.test.ts", "expect(x).toBe(2)")), true);
		assert.equal(log.filter((a) => "exception" in a.state).length, 2);
	});

	it("no path-level pre-judgement while a rule has an unless", async () => {
		const log: Asked[] = [];
		const { pi } = ledger(typoJudge(log));
		await pi.user("测试不要动，除非只是修 typo");
		await pi.callTool("heed_record", { quote: "测试不要动，除非只是修 typo", effect: "deny", action: "modify", target: "tests", scope: "session", unless: "只是修 typo" });
		// the path streams first; the content that decides comes later
		await pi.emit("message_update", {
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, partial: { content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "test/a.test.ts", edits: [] } }] } },
		});
		assert.equal(await blocked(pi, { toolCallId: "c1", toolName: "edit", input: { path: "test/a.test.ts", edits: [{ oldText: "a", newText: "b" }] } }), true);
		assert.equal(await blocked(pi, typoEdit("test/a.test.ts")), false);
	});

	it("an exception sets aside only its own rule: a broader read-only still applies", async () => {
		const { pi } = ledger(typoJudge());
		await pi.user("只读。测试不要动，除非只是修 typo");
		await pi.callTool("heed_record", { quote: "只读", effect: "deny", action: "modify", target: "*", scope: "session" });
		await pi.callTool("heed_record", { quote: "测试不要动，除非只是修 typo", effect: "deny", action: "modify", target: "tests", scope: "session", unless: "只是修 typo" });
		assert.equal(await blocked(pi, typoEdit("test/a.test.ts")), true);
	});

	it("an exception does not skip free-text rules", async () => {
		const judge = fakeJudge((a) =>
			a.key === "q" && "exception" in a.state ? choice("excepted") : a.key === "q" && "user_constraints" in a.state ? choice("violates") : undefined,
		);
		const { pi } = ledger(judge);
		await pi.user("测试不要动，除非只是修 typo。不要改许可证声明。");
		await pi.callTool("heed_record", { quote: "测试不要动，除非只是修 typo", effect: "deny", action: "modify", target: "tests", scope: "session", unless: "只是修 typo" });
		await pi.callTool("heed_record", { quote: "不要改许可证声明", effect: "deny", action: "custom", text: "changing the license header", scope: "session" });
		assert.equal(await blocked(pi, typoEdit("test/a.test.ts")), true);
	});
});

describe("ledger: free-text rules reach commands that change nothing locally", () => {
	it("a GET to the production API is judged; npm test and git status are not", async () => {
		const log: Asked[] = [];
		const judge = fakeJudge((a) => (a.key === "q" && "user_constraints" in a.state ? choice(/prod/.test(JSON.stringify(a.state.pending_tool_call)) ? "violates" : "complies") : undefined), log);
		const { pi } = ledger(judge);
		await pi.user("Never call the production API.");
		await pi.callTool("heed_record", { quote: "Never call the production API", effect: "deny", action: "custom", text: "calling the production API", scope: "session" });
		assert.equal(await blocked(pi, toolCall("bash", { command: "curl https://api.prod.example.com/v1/orders" })), true);
		const before = log.length;
		assert.equal(await blocked(pi, toolCall("bash", { command: "npm test" })), false);
		assert.equal(await blocked(pi, toolCall("bash", { command: "git status" })), false);
		assert.equal(log.filter((a) => "user_constraints" in a.state).length, log.slice(0, before).filter((a) => "user_constraints" in a.state).length);
	});
});

describe("ledger + regex: the parser's explicit rules, and the model's detail wins", () => {
	it("keeps explicit hard rules; drops holds, free text and pasted material", async () => {
		const { pi, heed } = ledger(null, "ledger+regex");
		await pi.user("先别改，先讨论一下。不要 push。不要为了架构漂亮重写。");
		assert.deepEqual(active(heed), ["DENY git push (session)"]);
		const paste = ["给其他 AI 的提示词", `你是审查员。只读审查，不要修改文件、不要提交。\n${"- 检查一项。\n".repeat(120)}`, "你看看这个提示词"].join("\n\n");
		await next(pi, paste);
		assert.deepEqual(active(heed), ["DENY git push (session)"]);
	});

	it("the user repeats the plain ban later: the parser does not drop the model's exception", async () => {
		const { pi, heed } = ledger(null, "ledger+regex");
		await pi.user("别动测试，除非只是修 typo");
		await pi.callTool("heed_record", { quote: "别动测试，除非只是修 typo", effect: "deny", action: "modify", target: "tests", scope: "session", unless: "只是修 typo" });
		await next(pi, "记住，别动测试");
		assert.deepEqual(active(heed), ['DENY modify tests unless "只是修 typo" (session)']);
	});

	it("parser first without the exception, model later with it: the model's rule stands", async () => {
		const { pi, heed } = ledger(null, "ledger+regex");
		await pi.user("别动测试，除非只是修 typo");
		assert.deepEqual(active(heed), ["DENY modify tests (session)"]);
		await pi.callTool("heed_record", { quote: "别动测试，除非只是修 typo", effect: "deny", action: "modify", target: "tests", scope: "session", unless: "只是修 typo" });
		assert.deepEqual(active(heed), ['DENY modify tests unless "只是修 typo" (session)']);
		// a restart replays the same order, and the parser does not undo it
		await pi.emit("session_start");
		assert.deepEqual(active(heed), ['DENY modify tests unless "只是修 typo" (session)']);
	});
});

describe("ledger: rebuild", () => {
	it("restart / branch switch keeps recorded rules and used permissions", async () => {
		const { pi, heed } = ledger();
		await pi.user("别改 package.json，也先别改别的，我们先讨论");
		await pi.callTool("heed_record", { quote: "别改 package.json", effect: "deny", action: "modify", target: "package.json", scope: "session" });
		await next(pi, "这一次可以改 package.json");
		await pi.callTool("heed_record", { quote: "这一次可以改 package.json", effect: "allow", action: "modify", target: "package.json", scope: "once" });
		assert.equal(await blocked(pi, edit("package.json")), false);
		const state = () => heed.engine.all().map((p: any) => `${p.id}:${p.status}`);
		const before = state();
		await pi.emit("session_start");
		assert.deepEqual(state(), before);
		await pi.emit("session_tree");
		assert.deepEqual(state(), before);
		assert.equal(await blocked(pi, edit("package.json")), true);
		assert.deepEqual(active(heed), ["DENY modify package.json (session)"], "no hold re-created by the parser on rebuild");
	});

	it("an injected message stays non-evidence after a rebuild", async () => {
		const { pi } = ledger();
		await pi.injected("[GOAL] Do NOT push anything.");
		await pi.emit("session_start");
		assert.match((await pi.callTool("heed_record", { quote: "Do NOT push anything", effect: "deny", action: "git_push", scope: "session" })).text, /Not recorded/);
	});
});

describe("ledger: no interpretation", () => {
	it("user messages never reach Jev", async () => {
		const log: Asked[] = [];
		const { pi } = ledger(fakeJudge(() => undefined, log));
		await pi.user("你先别改，先看看和我讨论");
		await next(pi, "改吧");
		assert.equal(log.length, 0);
	});

	it("the budget: a fourth violation in one run goes through (a product choice, measured separately)", async () => {
		const { pi } = ledger();
		await pi.user("Don't push.");
		await pi.callTool("heed_record", { quote: "Don't push", effect: "deny", action: "git_push", scope: "session" });
		const r = [];
		for (let i = 0; i < 4; i++) r.push(await blocked(pi, toolCall("bash", { command: "git push" })));
		assert.deepEqual(r, [true, true, true, false]);
	});
});

describe("ledger: a lasting permission is a lift and gets the same check", () => {
	const judge = () => fakeJudge((a) => (a.key === "q" && "rule_said" in a.state ? (/from now on|以后都/.test(a.state.user_message) ? choice("takes_back") : choice("keeps")) : undefined));

	it("allow session against a rule needs the user's message to take it back; once/run do not", async () => {
		const { pi } = ledger(judge());
		await pi.user("Don't push.");
		await pi.callTool("heed_record", { quote: "Don't push", effect: "deny", action: "git_push", scope: "session" });
		await next(pi, "You can push now.");
		assert.match((await pi.callTool("heed_record", { quote: "You can push now", effect: "allow", action: "git_push", scope: "session" })).text, /Not recorded.*scope once or run/);
		assert.match((await pi.callTool("heed_record", { quote: "You can push now", effect: "allow", action: "git_push", scope: "once" })).text, /Recorded/);
		assert.equal(await blocked(pi, toolCall("bash", { command: "git push" })), false);
		assert.equal(await blocked(pi, toolCall("bash", { command: "git push" })), true);
		await next(pi, "Push freely from now on.");
		assert.match((await pi.callTool("heed_record", { quote: "Push freely from now on", effect: "allow", action: "git_push", scope: "session" })).text, /Recorded/);
		assert.equal(await blocked(pi, toolCall("bash", { command: "git push" })), false);
	});

	it("a lasting narrow permission under a broad rule gets the check too", async () => {
		const { pi } = ledger(judge());
		await pi.user("src 不能改");
		await pi.callTool("heed_record", { quote: "src 不能改", effect: "deny", action: "modify", target: "src", scope: "session" });
		await next(pi, "src/api 可以改");
		assert.match((await pi.callTool("heed_record", { quote: "src/api 可以改", effect: "allow", action: "modify", target: "src/api", scope: "session" })).text, /Not recorded/);
		await next(pi, "src/api 以后都可以改");
		assert.match((await pi.callTool("heed_record", { quote: "src/api 以后都可以改", effect: "allow", action: "modify", target: "src/api", scope: "session" })).text, /Recorded/);
		assert.equal(await blocked(pi, edit("src/api/user.ts")), false);
		assert.equal(await blocked(pi, edit("src/app.ts")), true);
	});
});

