// The intent/task ledger: the main model records what the user wants done (heed_task), next to the rules it records
// (heed_record). pi-heed checks receipts, ties rules to their task and shows the task back to the model.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Answer, Judge, Question } from "../src/judge.ts";
import { describe as describePolicy } from "../src/policy.ts";
import { renderTasks, TaskLedger } from "../src/task.ts";
import { FakePi, setup, toolCall } from "./harness.ts";

type Asked = { key: string; q: Question; state: any };
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

function ledger(judge: Judge | null = null, env: Record<string, string> = {}) {
	return setup({ judge, env: { PI_HEED_MODE: "enforce", PI_HEED_PIPELINE: "ledger", ...env } } as never);
}
async function next(pi: FakePi, text: string) {
	await pi.emit("agent_end");
	await pi.user(text);
}
const edit = (path: string) => toolCall("edit", { path, edits: [{ oldText: "a", newText: "b" }] });
const blocked = async (pi: FakePi, call: ReturnType<typeof toolCall>) => !!(await pi.emit("tool_call", call))?.block;
const active = (h: any) => h.engine.active().map((p: any) => describePolicy(p));
const prompt = async (pi: FakePi) => (await pi.emit("before_agent_start", { prompt: "x", systemPrompt: "BASE" }))?.systemPrompt as string | undefined;
// Jev confirms a new task only when the message mentions the billing page
const newTaskJudge = (log: Asked[] = []) => fakeJudge((a) => (a.key === "q" && "current_task" in a.state ? choice(/billing/.test(a.state.user_message) ? "new_task" : "continues") : undefined), log);

describe("task ledger: recording", () => {
	it("starts a task from the user's words and shows it to the model", async () => {
		const { pi, heed } = ledger();
		await pi.user("Fix the flaky login test. Keep the public API unchanged.");
		assert.equal(await prompt(pi), undefined, "nothing to show yet");
		const r = await pi.callTool("heed_task", { op: "start", goal: "fix the flaky login test", quote: "Fix the flaky login test" });
		assert.match(r.text, /Started/);
		await pi.callTool("heed_task", { op: "note", text: "keep the public API unchanged", quote: "Keep the public API unchanged" });
		const t = heed.tasks.current()!;
		assert.equal(t.id, "t1");
		assert.equal(t.at, 0);
		assert.deepEqual(t.decisions.map((d) => d.text), ["keep the public API unchanged"]);
		const sp = (await prompt(pi))!;
		assert.match(sp, /^BASE\n\n## The user's task/);
		assert.match(sp, /Current task t1 \(execute\): fix the flaky login test/);
		assert.match(sp, /Decided: keep the public API unchanged/);
	});

	it("needs a receipt: a quote the user never typed, or only an extension injected, is refused", async () => {
		const { pi, heed } = ledger();
		await pi.injected("[GOAL] Rewrite the whole app.");
		await pi.user("Look at the build.");
		assert.match((await pi.callTool("heed_task", { op: "start", goal: "rewrite", quote: "Rewrite the whole app" })).text, /Not started/);
		assert.match((await pi.callTool("heed_task", { op: "start", goal: "x" })).text, /needs the user's exact words/);
		assert.match((await pi.callTool("heed_task", { op: "note", text: "x", quote: "Look at the build" })).text, /no current task/);
		assert.equal(heed.tasks.all().length, 0);
	});

	it("a new task needs a newer message than the current one", async () => {
		const { pi } = ledger();
		await pi.user("Fix the parser, then update the docs.");
		await pi.callTool("heed_task", { op: "start", goal: "fix the parser", quote: "Fix the parser" });
		assert.match((await pi.callTool("heed_task", { op: "start", goal: "update the docs", quote: "update the docs" })).text, /not newer/);
	});

	it("pi-heed's own task tool is never checked, even under read-only", async () => {
		const { pi } = ledger();
		await pi.user("Read-only review of the auth module.");
		await pi.callTool("heed_record", { quote: "Read-only", effect: "deny", action: "modify", target: "*", scope: "session" });
		const r = await pi.callTool("heed_task", { op: "start", goal: "review the auth module", quote: "review of the auth module" });
		assert.equal(r.blocked, false);
	});
});

describe("task ledger: stage replaces the hold", () => {
	it("'先看看' is a discuss stage, not a ban; going to execute takes a newer go-ahead", async () => {
		const { pi, heed } = ledger();
		await pi.user("帮我重构缓存层，先看看方案，确认后再改");
		await pi.callTool("heed_task", { op: "start", goal: "refactor the cache layer", quote: "帮我重构缓存层", stage: "discuss" });
		assert.deepEqual(active(heed), [], "no rule from pacing");
		assert.equal(await blocked(pi, edit("src/cache.ts")), false, "the stage is not enforced");
		assert.match((await prompt(pi))!, /discuss: the user wants analysis or a plan before changes/);
		assert.match((await pi.callTool("heed_task", { op: "stage", stage: "execute", quote: "确认后再改" })).text, /Not changed/);
		await next(pi, "方案 B 可以，改吧");
		await pi.callTool("heed_task", { op: "note", text: "use approach B", quote: "方案 B 可以" });
		assert.match((await pi.callTool("heed_task", { op: "stage", stage: "execute", quote: "改吧" })).text, /discuss → execute/);
		assert.equal(heed.tasks.current()!.stage, "execute");
	});
});

describe("task ledger: rules scoped to a task", () => {
	it("scope task needs a current task", async () => {
		const { pi } = ledger();
		await pi.user("这个任务里别动 API 层");
		assert.match((await pi.callTool("heed_record", { quote: "别动 API 层", effect: "deny", action: "modify", target: "src/api", scope: "task" })).text, /needs a current task/);
	});

	it("every rule remembers its task; a task rule ends when Jev confirms a new task", async () => {
		const { pi, heed } = ledger(newTaskJudge());
		await pi.user("修一下登录 bug，这个任务里别动 src/api，也别 push");
		await pi.callTool("heed_task", { op: "start", goal: "fix the login bug", quote: "修一下登录 bug" });
		await pi.callTool("heed_record", { quote: "这个任务里别动 src/api", effect: "deny", action: "modify", target: "src/api", scope: "task" });
		await pi.callTool("heed_record", { quote: "也别 push", effect: "deny", action: "git_push", scope: "session" });
		assert.deepEqual(active(heed), ["DENY modify src/api (task t1)", "DENY git push (session)"]);
		assert.equal(heed.engine.get("p2")!.task, "t1", "a session rule still records where it came from");
		assert.match((await prompt(pi))!, /Rule: \[p1\] Do not modify src\/api \(for task t1\)/);
		assert.equal(await blocked(pi, edit("src/api/user.ts")), true);

		// a follow-up is not a new task: Jev says it continues, the task rule stays
		await next(pi, "顺便把空值的情况也处理一下");
		const r = await pi.callTool("heed_task", { op: "start", goal: "handle the empty case", quote: "顺便把空值的情况也处理一下" });
		assert.match(r.text, /Kept p1 from t1 for this task/);
		assert.equal(heed.engine.get("p1")!.task, "t2", "carried over to the follow-up");
		assert.equal(await blocked(pi, edit("src/api/user.ts")), true);

		// the user really moves on
		await next(pi, "Now let's look at the billing page instead.");
		const s = await pi.callTool("heed_task", { op: "start", goal: "look at the billing page", quote: "look at the billing page" });
		assert.match(s.text, /Started/);
		assert.equal(heed.tasks.get("t2")!.status, "replaced");
		assert.deepEqual(active(heed), ["DENY git push (session)"]);
		assert.equal(await blocked(pi, edit("src/api/user.ts")), false);
	});

	it("the previous task's rules end only when the next start is confirmed; without Jev they stay", async () => {
		const { pi, heed } = ledger(null);
		await pi.user("Fix the login bug; for this task don't touch src/api.");
		await pi.callTool("heed_task", { op: "start", goal: "fix the login bug", quote: "Fix the login bug" });
		await pi.callTool("heed_record", { quote: "for this task don't touch src/api", effect: "deny", action: "modify", target: "src/api", scope: "task" });
		await next(pi, "Now let's look at the billing page instead.");
		const r = await pi.callTool("heed_task", { op: "start", goal: "billing page", quote: "look at the billing page" });
		assert.match(r.text, /Kept p1 from t1 for this task: it could not be checked \(no judge configured\)/);
		assert.equal(await blocked(pi, edit("src/api/user.ts")), true);
		assert.deepEqual(active(heed), ["DENY modify src/api (task t2)"]);
	});

	it("with Jev, a confirmed new task ends the old task's rules but not session rules", async () => {
		const { pi, heed } = ledger(newTaskJudge());
		await pi.user("Fix the login bug; for this task don't touch src/api. Never push.");
		await pi.callTool("heed_task", { op: "start", goal: "fix the login bug", quote: "Fix the login bug" });
		await pi.callTool("heed_record", { quote: "for this task don't touch src/api", effect: "deny", action: "modify", target: "src/api", scope: "task" });
		await pi.callTool("heed_record", { quote: "Never push", effect: "deny", action: "git_push", scope: "session" });
		await next(pi, "Now let's look at the billing page instead.");
		await pi.callTool("heed_task", { op: "start", goal: "billing page", quote: "look at the billing page" });
		assert.deepEqual(active(heed), ["DENY git push (session)"]);
		assert.equal(await blocked(pi, edit("src/api/user.ts")), false);
		assert.match(heed.engine.get("p1")!.provenance.endReason!, /goal ended/);
	});

	it("a task permission ends when the task is done; the done task's restrictions wait for the next task", async () => {
		const { pi, heed } = ledger();
		await pi.user("Add a date picker; for this task you can install packages. Don't touch the tests in this task.");
		await pi.callTool("heed_task", { op: "start", goal: "add a date picker", quote: "Add a date picker" });
		await pi.callTool("heed_record", { quote: "for this task you can install packages", effect: "allow", action: "install_deps", scope: "task" });
		await pi.callTool("heed_record", { quote: "Don't touch the tests in this task", effect: "deny", action: "modify", target: "tests", scope: "task" });
		assert.match((await pi.callTool("heed_task", { op: "done" })).text, /Done/);
		assert.deepEqual(active(heed), ["DENY modify tests (task t1)"]);
		assert.equal(heed.tasks.current(), undefined);
		assert.match((await prompt(pi))!, /No active task\.\nEarlier: t1 done: add a date picker/);
	});

	it("a lasting task permission against a rule needs Jev's agreement, like a session one", async () => {
		const { pi } = ledger(null);
		await pi.user("别动测试。修 bug，这个任务里测试可以改");
		await pi.callTool("heed_record", { quote: "别动测试", effect: "deny", action: "modify", target: "tests", scope: "session" });
		await pi.callTool("heed_task", { op: "start", goal: "fix the bug", quote: "修 bug" });
		const r = await pi.callTool("heed_record", { quote: "这个任务里测试可以改", effect: "allow", action: "modify", target: "tests", scope: "task" });
		assert.match(r.text, /Not recorded/);
		assert.equal(await blocked(pi, edit("a.test.ts")), true);
	});
});

describe("task ledger: what the model sees when blocked", () => {
	it("the block names the current task, so the model can say what conflicts", async () => {
		const { pi } = ledger();
		await pi.user("Update the README. Don't push.");
		await pi.callTool("heed_task", { op: "start", goal: "update the README", quote: "Update the README" });
		await pi.callTool("heed_record", { quote: "Don't push", effect: "deny", action: "git_push", scope: "session" });
		const r = await pi.emit("tool_call", toolCall("bash", { command: "git push" }));
		assert.match(r.reason, /Current task t1: update the README/);
	});
});

describe("task ledger: persistence and switches", () => {
	it("a restart replays the tasks, decisions and task-scoped rules", async () => {
		const { pi, heed } = ledger(newTaskJudge());
		await pi.user("先看看缓存层怎么重构，这个任务里别动 src/api");
		await pi.callTool("heed_task", { op: "start", goal: "refactor the cache", quote: "先看看缓存层怎么重构", stage: "discuss" });
		await pi.callTool("heed_record", { quote: "这个任务里别动 src/api", effect: "deny", action: "modify", target: "src/api", scope: "task" });
		await next(pi, "用方案 B，开始改吧");
		await pi.callTool("heed_task", { op: "note", text: "use approach B", quote: "用方案 B" });
		await pi.callTool("heed_task", { op: "stage", stage: "execute", quote: "开始改吧" });
		const snap = () => JSON.stringify([heed.tasks.all(), heed.engine.all()]);
		const before = snap();
		const sp = await prompt(pi);
		await pi.emit("session_start");
		assert.equal(snap(), before);
		assert.equal(await prompt(pi), sp, "same state, same system prompt (cache-friendly)");
	});

	it("PI_HEED_TASKS=0 turns it off: no tool, no prompt, no task scope", async () => {
		const { pi } = ledger(null, { PI_HEED_TASKS: "0" });
		assert.equal(pi.registered.has("heed_task"), false);
		assert.equal(pi.registered.has("heed_record"), true);
		assert.doesNotMatch(JSON.stringify(pi.registered.get("heed_record").parameters), /"task"/);
		await pi.user("x");
		assert.equal(await prompt(pi), undefined);
	});

	it("the interpreter pipeline has no task ledger", async () => {
		const { pi } = setup({ judge: null, env: { PI_HEED_MODE: "enforce", PI_HEED_PIPELINE: "interpret" } } as never);
		assert.equal(pi.registered.has("heed_task"), false);
	});
});

describe("task ledger: Jev sees the task only when asked to (PI_HEED_TASK_CONTEXT=1)", () => {
	const run = async (env: Record<string, string>) => {
		const log: Asked[] = [];
		const { pi } = ledger(
			fakeJudge((a) => (a.key === "q" && "user_constraints" in a.state ? choice("complies") : undefined), log),
			env,
		);
		await pi.user("Seed the staging database. Never touch production data.");
		await pi.callTool("heed_task", { op: "start", goal: "seed the staging database", quote: "Seed the staging database" });
		await pi.callTool("heed_record", { quote: "Never touch production data", effect: "deny", action: "custom", text: "touching production data", scope: "session" });
		await pi.emit("tool_call", toolCall("bash", { command: "psql $STAGING_URL -f seed.sql" }));
		return log.find((a) => "user_constraints" in a.state)!.state;
	};

	it("off by default", async () => {
		assert.equal((await run({})).user_task, undefined);
	});

	it("on: the goal and decisions go last in the state", async () => {
		const state = await run({ PI_HEED_TASK_CONTEXT: "1" });
		assert.deepEqual(state.user_task, { goal: "seed the staging database", decisions: [] });
		assert.equal(Object.keys(state).at(-1), "user_task");
	});
});

describe("renderTasks", () => {
	it("shows the current task, its decisions and rules, and up to three earlier tasks", () => {
		const l = new TaskLedger();
		for (let i = 0; i < 5; i++) l.apply({ op: "start", goal: `task ${i}`, quote: `q${i}`, at: i, stage: "execute" });
		l.apply({ op: "note", id: "t5", text: "keep it small", quote: "small", at: 4 });
		const out = renderTasks(l, (id) => (id === "t5" ? ["[p1] Do not git push"] : []));
		assert.equal(
			out,
			[
				'Current task t5 (execute): task 4. The user said: "q4"',
				'- Decided: keep it small (user: "small")',
				"- Rule: [p1] Do not git push",
				"Earlier: t2 replaced: task 1; t3 replaced: task 2; t4 replaced: task 3",
			].join("\n"),
		);
	});
});
