import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Answer, Judge, Question } from "../src/judge.ts";
import { type FakePi, kinds, setup, toolCall } from "./harness.ts";

// Policy lifecycle, end to end through the extension (fake pi events, enforce mode).

const enforce = (judge: Judge | null = null) => setup({ config: { mode: "enforce", maxInterventionsPerRun: 100 }, judge });

async function blocked(pi: FakePi, tool: string, input: Record<string, unknown>): Promise<boolean> {
	const tc = toolCall(tool, input);
	const r = await pi.emit("tool_call", tc);
	if (!r?.block) await pi.emit("tool_result", { ...tc, isError: false, content: [] }); // the call ran
	return !!r?.block;
}
const edit = (pi: FakePi, path: string) => blocked(pi, "edit", { path, edits: [] });
const bash = (pi: FakePi, command: string) => blocked(pi, "bash", { command });

/** Ends the current run like pi does before the next prompt. */
async function next(pi: FakePi, text: string) {
	await pi.emit("agent_end", { messages: [] });
	await pi.user(text);
}

function deltaJudge(fn: (key: string, q: Question) => Answer | undefined): Judge {
	return {
		name: "fake",
		decide: async (_s, qs) => Object.fromEntries(Object.entries(qs).flatMap(([k, q]) => { const a = fn(k, q); return a ? [[k, a]] : []; })),
	};
}
const choice = (c: string, p = 0.97, confidence = 0.9): Answer => ({ type: "choice", choice: c, probabilities: { [c]: p }, confidence });

describe("lifecycle: add / lift / exception / narrow", () => {
	it("lift: 不要改测试 → 现在测试可以改了", async () => {
		const { pi, heed } = enforce();
		await pi.user("不要改测试");
		assert.equal(await edit(pi, "src/a.test.ts"), true);
		await next(pi, "现在测试可以改了");
		assert.equal(await edit(pi, "src/a.test.ts"), false);
		assert.deepEqual(kinds(heed.engine), []);
		assert.equal(heed.engine.history()[0].status, "superseded");
		assert.match(heed.engine.history()[0].provenance.endReason!, /lifted/);
	});

	it("partial exception: 其他都别改，但 notes.txt 可以", async () => {
		const { pi } = enforce();
		await pi.user("其他都别改，但 notes.txt 可以");
		assert.equal(await edit(pi, "notes.txt"), false);
		assert.equal(await bash(pi, "echo reviewed >> notes.txt"), false);
		assert.equal(await edit(pi, "src/app.ts"), true);
		assert.equal(await bash(pi, "cp notes.txt src/app.ts"), true); // any restricted target restricts the call
	});

	it("nested exception: src denied, src/auth allowed, src/auth/secrets.ts denied", async () => {
		const { pi } = enforce();
		await pi.user("src 不能改，但 src/auth 可以，不过 src/auth/secrets.ts 还是不能动");
		assert.equal(await edit(pi, "src/app.ts"), true);
		assert.equal(await edit(pi, "src/auth/login.ts"), false);
		assert.equal(await edit(pi, "src/auth/secrets.ts"), true);
		assert.equal(await edit(pi, "docs/readme.md"), false);
	});

	it("narrow later: a newer, more specific allow carves into an older broad deny", async () => {
		const { pi, heed } = enforce();
		await pi.user("Don't touch src.");
		await next(pi, "Actually src/auth is fine to edit.");
		assert.equal(await edit(pi, "src/auth/x.ts"), false);
		assert.equal(await edit(pi, "src/x.ts"), true);
		assert.deepEqual(heed.engine.active().find((p) => p.effect === "DENY")!.exceptions.length, 1);
	});

	it("except-clause in English", async () => {
		const { pi } = enforce();
		await pi.user("Don't modify anything except notes.txt.");
		assert.equal(await edit(pi, "notes.txt"), false);
		assert.equal(await edit(pi, "a.ts"), true);
	});
});

describe("lifecycle: temporary scopes", () => {
	it("once permission is used up by the first call", async () => {
		const { pi, heed } = enforce();
		await pi.user("别改 package.json");
		await next(pi, "这一次可以改 package.json");
		assert.equal(await edit(pi, "package.json"), false);
		assert.equal(await edit(pi, "package.json"), true);
		assert.ok(heed.engine.history().some((p) => p.scope === "once" && p.status === "expired"));
	});

	it("run-scoped permission ends with the run", async () => {
		const { pi } = enforce();
		await pi.user("No new dependencies.");
		await next(pi, "这一轮可以装依赖");
		assert.equal(await bash(pi, "npm install lodash"), false);
		assert.equal(await bash(pi, "npm install left-pad"), false);
		await next(pi, "continue");
		assert.equal(await bash(pi, "npm install zod"), true);
	});

	it("a once permission under read-only does not lift read-only", async () => {
		const { pi } = enforce();
		await pi.user("Read-only review, don't modify any files.");
		await next(pi, "Just this once you can edit notes.txt");
		assert.equal(await edit(pi, "notes.txt"), false);
		assert.equal(await edit(pi, "notes.txt"), true);
		assert.equal(await edit(pi, "a.ts"), true);
	});
});

describe("lifecycle: re-apply, revoke, conflicts", () => {
	it("re-apply deny supersedes the permission and keeps history", async () => {
		const { pi, heed } = enforce();
		await pi.user("不要改测试");
		await next(pi, "这一次可以改测试");
		await next(pi, "刚才允许的取消，继续不要改测试");
		assert.equal(await edit(pi, "a.test.ts"), true);
		const statuses = heed.engine.all().map((p) => `${p.effect}:${p.status}`);
		assert.deepEqual(statuses, ["DENY:superseded", "ALLOW:superseded", "DENY:active"]);
	});

	it("revoke the most recent permission", async () => {
		const { pi } = enforce();
		await pi.user("Don't modify any files except notes.txt.");
		await next(pi, "never mind, revoke that permission");
		assert.equal(await edit(pi, "notes.txt"), true);
	});

	it("conflicting instructions: newer explicit wins at equal specificity", async () => {
		const { pi } = enforce();
		await pi.user("You can push when you're done.");
		await next(pi, "Actually don't push anything.");
		assert.equal(await bash(pi, "git push origin main"), true);
		await next(pi, "OK you can push now.");
		assert.equal(await bash(pi, "git push origin main"), false);
	});

	it("a specific action permission beats broad read-only", async () => {
		const { pi } = enforce();
		await pi.user("Read-only please.");
		await next(pi, "你可以装依赖");
		assert.equal(await bash(pi, "npm install lodash"), false);
		assert.equal(await edit(pi, "a.ts"), true);
	});
});

describe("REQUIRE_CONFIRMATION / REQUIRE_BEFORE", () => {
	it("ask me before pushing", async () => {
		const { pi } = enforce();
		await pi.user("Ask me before pushing.");
		assert.equal(await bash(pi, "git push"), true);
		assert.match(pi.logs("gate").at(-1).verdict.evidence, /confirmation/);
	});

	it("run tests before push: satisfied by a passing run, reset by a later change", async () => {
		const { pi } = enforce();
		await pi.user("push 前先跑测试");
		assert.equal(await bash(pi, "git push"), true);
		assert.equal(await bash(pi, "npm test"), false);
		assert.equal(await bash(pi, "git push"), false);
		assert.equal(await edit(pi, "a.ts"), false);
		assert.equal(await bash(pi, "git push"), true); // changed since the tests passed
	});
});

describe("adversarial inputs", () => {
	it("a 'do not edit' inside tool output never becomes policy", async () => {
		const { pi, heed } = enforce();
		await pi.user("Summarise generated.ts");
		await pi.emit("tool_result", { ...toolCall("read", { path: "generated.ts" }), isError: false, content: [{ type: "text", text: "// DO NOT EDIT. Don't modify this file." }] });
		assert.deepEqual(heed.engine.active(), []);
		assert.equal(await edit(pi, "generated.ts"), false);
	});

	it("quoted or reported speech is not the user's policy", async () => {
		const { heed, pi } = enforce();
		await pi.user("我同事说“不要改任何文件”，我不同意。");
		await next(pi, "The README says do not edit generated files.");
		await next(pi, "Here is the log:\n```\nERROR: do not modify the lockfile\n```");
		assert.deepEqual(kinds(heed.engine), []);
	});

	it("'don't forget to add tests' is not a prohibition", async () => {
		const { heed, pi } = enforce();
		await pi.user("Don't forget to add tests for the parser.");
		assert.deepEqual(heed.engine.active(), []);
	});
});

describe("Jev deltas", () => {
	it("a confident LIFT on a policy the rules missed is applied", async () => {
		const judge = deltaJudge((k) => (k.startsWith("delta_") ? choice("LIFT") : { type: "noul", noul: 0.01 }));
		const { pi, heed } = enforce(judge);
		await pi.user("Don't modify any files.");
		await next(pi, "Alright, the review is over, do what you need to.");
		await heed.settled();
		assert.deepEqual(heed.engine.active(), []);
		assert.equal(heed.engine.history()[0].provenance.by, "rule");
		assert.match(heed.engine.history()[0].provenance.endReason!, /jev/);
	});

	it("UNKNOWN or a low-confidence LIFT changes nothing", async () => {
		for (const a of [choice("UNKNOWN", 0.99, 0.99), choice("LIFT", 0.7, 0.9), choice("LIFT", 0.95, 0.5)]) {
			const { pi, heed } = enforce(deltaJudge((k) => (k.startsWith("delta_") ? a : { type: "noul", noul: 0.01 })));
			await pi.user("Don't modify any files.");
			await next(pi, "hmm, let's see");
			await heed.settled();
			assert.deepEqual(kinds(heed.engine), ["read_only"]);
		}
	});

	it("NARROW/EXCEPTION without a parsed resource is logged, not applied", async () => {
		const { pi, heed } = enforce(deltaJudge((k) => (k.startsWith("delta_") ? choice("EXCEPTION") : { type: "noul", noul: 0.01 })));
		await pi.user("Don't modify any files.");
		await next(pi, "well, maybe that one is ok");
		await heed.settled();
		assert.deepEqual(kinds(heed.engine), ["read_only"]);
		assert.equal(pi.logs("constraint").at(-1).deltas.p1.kind, "EXCEPTION");
		assert.equal(pi.logs("constraint").at(-1).deltas.p1.applied, false);
	});

	it("a confident EXCEPTION gets its resource from the single path the message names", async () => {
		const { pi, heed } = enforce(deltaJudge((k) => (k.startsWith("delta_") ? choice("EXCEPTION") : { type: "noul", noul: 0.01 })));
		await pi.user("Don't modify any files.");
		await next(pi, "I've changed my mind for notes.txt only.");
		await heed.settled();
		assert.equal(await edit(pi, "notes.txt"), false);
		assert.equal(await edit(pi, "README.md"), true);
		assert.equal(heed.engine.active().find((p) => p.effect === "ALLOW")!.provenance.by, "jev");
	});

	it("EXCEPTION naming two paths is ambiguous and not applied", async () => {
		const { pi, heed } = enforce(deltaJudge((k) => (k.startsWith("delta_") ? choice("EXCEPTION") : { type: "noul", noul: 0.01 })));
		await pi.user("Don't modify any files.");
		await next(pi, "hmm, notes.txt and todo.md, those two maybe");
		await heed.settled();
		assert.deepEqual(kinds(heed.engine), ["read_only"]);
	});

	it("a Jev EXCEPTION never turns a rule-parsed once-permission into a lasting one", async () => {
		const { pi, heed } = enforce(deltaJudge((k) => (k.startsWith("delta_") ? choice("EXCEPTION") : { type: "noul", noul: 0.01 })));
		await pi.user("Don't edit package.json.");
		await next(pi, "Just this once you can edit package.json to bump the version.");
		await heed.settled();
		assert.equal(await edit(pi, "package.json"), false);
		assert.equal(await edit(pi, "package.json"), true);
	});

	it("Jev marks a permission temporary", async () => {
		const { pi, heed } = enforce(deltaJudge((k) => ({ type: "noul", noul: k === "temporary" ? 0.95 : 0.01 })));
		await pi.user("Don't touch src.");
		await next(pi, "You can edit src/auth/x.ts, only for this fix.");
		await heed.settled();
		assert.equal(heed.engine.active().find((p) => p.effect === "ALLOW")!.scope, "once");
	});

	it("go-ahead lifts read-only; not when the rules found a scoped permission in the same message", async () => {
		const go = (p: number): Answer => ({ type: "choice", choice: "go_ahead", probabilities: { go_ahead: p, not_yet: 1 - p }, confidence: 0.9 });
		const judge = deltaJudge((k) => (k === "go_ahead" ? go(0.95) : k.startsWith("delta_") ? choice("KEEP") : undefined));
		const a = enforce(judge);
		await a.pi.user("Don't modify any files.");
		await next(a.pi, "Ship it.");
		await a.heed.settled();
		assert.deepEqual(a.heed.engine.active(), []);

		const b = enforce(judge);
		await b.pi.user("Don't modify any files.");
		await next(b.pi, "You can edit notes.txt only.");
		await b.heed.settled();
		assert.deepEqual(kinds(b.heed.engine), ["read_only", "ALLOW:notes.txt"]);
	});

	it("an unclear go-ahead changes nothing", async () => {
		const judge = deltaJudge((k) => (k === "go_ahead" ? { type: "choice", choice: "unclear", probabilities: { unclear: 0.6, go_ahead: 0.3 }, confidence: 0.5 } : undefined));
		const { pi, heed } = enforce(judge);
		await pi.user("Don't modify any files.");
		await next(pi, "hmm ok");
		await heed.settled();
		assert.deepEqual(kinds(heed.engine), ["read_only"]);
	});

	it("tool relevance: a free-text prohibition is not checked on tools that cannot break it", async () => {
		const asked: string[] = [];
		const judge: Judge = {
			name: "fake",
			decide: async (_s, qs): Promise<Record<string, Answer>> => {
				asked.push(Object.keys(qs).sort().join(","));
				if ("edit" in qs) {
					const c = (x: string): Answer => ({ type: "choice", choice: x, probabilities: { [x]: 0.97 }, confidence: 0.95 });
					return { edit: c("cannot"), write: c("cannot"), bash: c("can_violate") };
				}
				if ("q" in qs) return { q: choice("violates", 0.97, 0.9) };
				return {};
			},
		};
		const { pi, heed } = enforce(judge);
		await pi.user("Never call the production API.");
		await heed.settled();
		for (let i = 0; i < 5; i++) assert.equal(await edit(pi, `src/f${i}.ts`), false);
		assert.equal(await bash(pi, "curl -X POST https://api.prod/x"), true);
		assert.equal(asked.filter((k) => k === "q").length, 1); // only the bash call was judged
		assert.equal(asked.filter((k) => k.includes("edit")).length, 1); // relevance asked once
	});

	it("Jev timeout leaves the rule state as it was", async () => {
		const slow: Judge = { name: "slow", decide: (_s, _q, signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("x")))) };
		const { pi, heed } = setup({ config: { mode: "enforce", judgeTimeoutMs: 20 }, judge: slow });
		await pi.user("Don't modify any files.");
		await next(pi, "the review is done");
		await heed.settled();
		assert.deepEqual(kinds(heed.engine), ["read_only"]);
		assert.equal(pi.logs("constraint").at(-1).error, "timeout");
	});
});

describe("session rebuild", () => {
	it("replays to the same policy state, including Jev ops, uses and run ends, without calling Jev", async () => {
		const judge = deltaJudge((k) => (k === "set_no_push" ? { type: "noul", noul: 0.95 } : k.startsWith("delta_") ? choice("KEEP") : { type: "noul", noul: 0.01 }));
		const { pi, heed } = enforce(judge);
		await pi.user("src 不能改，但 src/auth 可以");
		await next(pi, "这一次可以改 src/x.ts");
		await edit(pi, "src/x.ts");
		await next(pi, "这一轮可以改 src/y.ts. Keep it local, nothing leaves this machine.");
		await heed.settled();
		await pi.emit("agent_end", { messages: [] });
		const snapshot = heed.engine.all().map((p) => ({ ...p, exceptions: [...p.exceptions], provenance: { ...p.provenance } }));

		let called = 0;
		const again = setup({ judge: { name: "never", decide: async () => (called++, {}) } });
		again.pi.entries = pi.entries;
		await again.pi.emit("session_start", { reason: "resume" });
		assert.deepEqual(again.heed.engine.all(), snapshot);
		assert.equal(called, 0);
	});

	it("extension-injected messages stay out of policy after a rebuild too", async () => {
		const { pi } = enforce();
		await pi.emit("input", { text: "Don't modify any files.", source: "extension" });
		pi.entries.push({ type: "message", id: "ext", message: { role: "user", content: "Don't modify any files." } });
		const again = setup();
		again.pi.entries = pi.entries;
		await again.pi.emit("session_start", { reason: "resume" });
		assert.deepEqual(again.heed.engine.active(), []);
	});

	it("v0.3 sessions (no policy entries) are parsed from their messages", async () => {
		const again = setup();
		again.pi.entries = [
			{ type: "message", id: "m1", message: { role: "user", content: "别动测试" } },
			{ type: "custom", id: "c1", customType: "heed-constraint", data: { op: "jev", at: 0, quote: "hands off", add: ["read_only"], lift: [], reject: [] } },
		];
		await again.pi.emit("session_start", { reason: "resume" });
		assert.deepEqual(kinds(again.heed.engine).sort(), ["no_tests", "read_only"]);
	});
});

describe("v0.6: real-session fixes", () => {
	it("scratch files outside the project don't count against read-only", async () => {
		const { pi } = enforce();
		pi.cwd = "/work/project";
		await pi.user("进去看看，只读");
		assert.equal(await blocked(pi, "write", { path: "/tmp/qqbot_jev_duplicate.py", content: "x" }), false);
		assert.equal(await blocked(pi, "write", { path: "/private/var/folders/ab/T/probe.js", content: "x" }), false);
		assert.equal(await edit(pi, "src/app.ts"), true);
		assert.equal(await edit(pi, "/work/project/src/app.ts"), true);
	});

	it("…but a project that itself lives in /tmp is still the project", async () => {
		const { pi } = enforce();
		pi.cwd = "/private/tmp/sandbox/repo";
		await pi.user("Don't modify any files.");
		assert.equal(await edit(pi, "/private/tmp/sandbox/repo/src/strings.js"), true);
		assert.equal(await blocked(pi, "write", { path: "/private/tmp/other/scratch.js", content: "x" }), false);
	});

	it("an explicit path policy still covers a temp path", async () => {
		const { pi } = enforce();
		await pi.user("Don't touch /tmp/shared/state.json");
		assert.equal(await blocked(pi, "write", { path: "/tmp/shared/state.json", content: "x" }), true);
	});

	it("design guidance is not kept as an enforceable ban", async () => {
		const guidance: Answer = { type: "choice", choice: "design_guidance", probabilities: { design_guidance: 0.97, action_rule: 0.02 }, confidence: 0.95 };
		const rule: Answer = { type: "choice", choice: "action_rule", probabilities: { action_rule: 0.99 }, confidence: 0.98 };
		const { pi, heed } = enforce(deltaJudge((k, q: any) => (k.startsWith("kind_") ? (JSON.stringify(q).includes("架构") ? guidance : rule) : k.startsWith("real_") ? { type: "noul", noul: 0.9 } : undefined)));
		await pi.user("不要为了架构漂亮重写。Never call the production API.");
		await heed.settled();
		const custom = heed.engine.all().filter((p) => p.action === "custom");
		assert.equal(custom.length, 2);
		assert.equal(custom.find((p) => p.resource.includes("架构"))!.status, "superseded");
		assert.match(custom.find((p) => p.resource.includes("架构"))!.provenance.endReason!, /design guidance/);
		assert.equal(custom.find((p) => p.resource.includes("production"))!.status, "active");
	});

	it("extension tools a prohibition cannot concern skip the per-call check", async () => {
		const asked: string[] = [];
		const c = (x: string): Answer => ({ type: "choice", choice: x, probabilities: { [x]: 0.97 }, confidence: 0.95 });
		const judge: Judge = {
			name: "fake",
			decide: async (_s, qs): Promise<Record<string, Answer>> => {
				asked.push(Object.keys(qs).sort().join(","));
				if ("todo" in qs) return { edit: c("cannot"), write: c("cannot"), bash: c("can_violate"), todo: c("cannot"), deploy: c("can_violate") };
				if ("q" in qs) return { q: choice("violates", 0.97, 0.9) };
				return {};
			},
		};
		const { pi, heed } = enforce(judge);
		pi.tools = [
			{ name: "todo", description: "Create and update a task list" },
			{ name: "deploy", description: "Deploy the service to an environment" },
		];
		await pi.user("Never call the production API.");
		await heed.settled();
		assert.equal(await blocked(pi, "todo", { action: "create", subject: "x" }), false);
		assert.equal(await blocked(pi, "deploy", { env: "production" }), true);
		assert.equal(asked.filter((k) => k === "q").length, 1); // only deploy was judged
	});
});

describe("v0.7: inform, speed bump, review", () => {
	const start = (pi: FakePi) => pi.emit("before_agent_start", { prompt: "x", systemPrompt: "BASE" });

	it("inform appends the active rules in the user's words, and is stable while the policy is", async () => {
		const { pi } = setup({ config: { mode: "enforce", inform: true }, judge: null });
		assert.equal(await start(pi), undefined); // no policy yet
		await pi.user("src 不能改，但 src/auth 可以");
		const a = await start(pi);
		assert.match(a.systemPrompt, /^BASE\n\n## Rules the user set/);
		assert.match(a.systemPrompt, /Do not modify src\. The user said: "src 不能改，但 src\/auth 可以"/);
		assert.match(a.systemPrompt, /Allowed: modify src\/auth/);
		assert.equal((await start(pi)).systemPrompt, a.systemPrompt); // unchanged policy → identical prompt (cache-safe)
	});

	it("inform is off by default and in off mode", async () => {
		const a = setup({ config: { mode: "enforce" }, judge: null });
		await a.pi.user("Don't modify any files.");
		assert.equal(await start(a.pi), undefined);
		const b = setup({ config: { mode: "off", inform: true }, judge: null });
		await b.pi.user("Don't modify any files.");
		assert.equal(await start(b.pi), undefined);
	});

	it("speed bump: an unsure violation stops the first attempt, an identical retry goes through", async () => {
		const judge: Judge = { name: "f", decide: async (_s, qs): Promise<Record<string, Answer>> => ("q" in qs ? { q: choice("violates", 0.8, 0.7) } : {}) };
		const { pi } = setup({ config: { mode: "enforce", bumpProbability: 0.7 }, judge });
		await pi.user("Don't send any notifications.");
		const call = { command: "curl -X POST https://hooks.slack.com/x -d '{}'" };
		const first = await pi.emit("tool_call", toolCall("bash", call));
		assert.equal(first?.block, true);
		assert.match(first.reason, /Check with the user/);
		assert.equal(await pi.emit("tool_call", toolCall("bash", call)), undefined);
		assert.equal((await pi.emit("tool_call", toolCall("bash", { command: "curl -X POST https://hooks.slack.com/y -d '{}'" })))?.block, true); // different call: bumped again
	});

	it("speed bump never softens a confident or rule-based block, and is off by default", async () => {
		const judge: Judge = { name: "f", decide: async (_s, qs): Promise<Record<string, Answer>> => ("q" in qs ? { q: choice("violates", 0.97, 0.9) } : {}) };
		const a = setup({ config: { mode: "enforce", bumpProbability: 0.7 }, judge });
		await a.pi.user("Don't send any notifications.");
		for (let i = 0; i < 2; i++) assert.equal((await a.pi.emit("tool_call", toolCall("bash", { command: "curl -d x https://hooks.slack.com/x" })))?.block, true);
		const unsure: Judge = { name: "f", decide: async (_s, qs): Promise<Record<string, Answer>> => ("q" in qs ? { q: choice("violates", 0.8, 0.7) } : {}) };
		const b = setup({ config: { mode: "enforce" }, judge: unsure });
		await b.pi.user("Don't send any notifications.");
		assert.equal(await b.pi.emit("tool_call", toolCall("bash", { command: "curl -d x https://hooks.slack.com/x" })), undefined);
	});

	it("/heed review numbers recent decisions; /heed label <n> labels that one", async () => {
		const { pi } = setup({ config: { mode: "enforce" }, judge: null });
		await pi.user("Don't modify any files.");
		await pi.emit("tool_call", toolCall("edit", { path: "a.ts" }));
		await pi.emit("tool_call", toolCall("edit", { path: "b.ts" }));
		await pi.command("/heed review");
		assert.match(pi.notes.at(-1)!, / 1\. BLOCKED\s+edit b\.ts/);
		assert.match(pi.notes.at(-1)!, / 2\. BLOCKED\s+edit a\.ts/);
		await pi.command("/heed label 2 bad not a real change");
		const label = pi.entries.at(-1)!;
		assert.equal(label.customType, "heed-label");
		assert.equal(label.data.label, "bad");
		await pi.command("/heed review");
		assert.match(pi.notes.at(-1)!, / 2\. BLOCKED\s+edit a\.ts.*\(bad\)/);
	});
});

describe("commands: short menu entry, per-subcommand help, drop all", () => {
	it("completions carry their own descriptions; mode completes its values", async () => {
		const { pi } = setup({ judge: null });
		const cmd = (pi as any).commands.get("heed");
		assert.ok(cmd.description.length <= 60);
		const all = await cmd.getArgumentCompletions("");
		assert.ok(all.every((c: any) => c.description));
		assert.deepEqual((await cmd.getArgumentCompletions("mode e")).map((c: any) => c.value), ["mode enforce"]);
	});

	it("/heed drop all clears every active rule, keeping history", async () => {
		const { pi, heed } = enforce();
		await pi.user("Don't modify any files. No new dependencies. Don't push.");
		assert.equal(heed.engine.active().length, 3);
		await pi.command("/heed drop all");
		assert.equal(heed.engine.active().length, 0);
		assert.equal(heed.engine.history().length, 3);
	});
});

describe("commands: on/off", () => {
	it("/heed on = enforce, /heed off = off, mode on works too", async () => {
		const { pi, heed } = setup({ judge: null });
		await pi.command("/heed on");
		assert.equal(heed.config.mode, "enforce");
		await pi.command("/heed off");
		assert.equal(heed.config.mode, "off");
		await pi.command("/heed mode on");
		assert.equal(heed.config.mode, "enforce");
		const cmd = (pi as any).commands.get("heed");
		assert.match(cmd.description, /on \| off/);
	});
});

describe("E16: parsed restrictions that do not restrict the assistant", () => {
	const notRule = choice("not_a_rule", 0.99, 0.97);
	const binds = choice("restricts_assistant", 0.98, 0.95);

	it("an explanation request is not a push ban; the real rule in the next message is kept", async () => {
		const { pi, heed } = enforce(deltaJudge((k) => (k.startsWith("dir_") ? (heed.engine.all().length === 1 ? notRule : binds) : undefined)));
		await pi.user("为什么大家说不要 force push？解释一下。");
		await heed.settled();
		assert.equal(heed.engine.active().length, 0);
		assert.match(heed.engine.history()[0].provenance.endReason!, /not a restriction/);
		await pi.user("不要 push，我来 review。");
		await heed.settled();
		assert.equal(await blocked(pi, "bash", { command: "git push" }), true);
	});

	it("low confidence keeps the rule", async () => {
		const { pi, heed } = enforce(deltaJudge((k) => (k.startsWith("dir_") ? choice("not_a_rule", 0.95, 0.6) : undefined)));
		await pi.user("Don't push.");
		await heed.settled();
		assert.equal(heed.engine.active().length, 1);
	});
});

describe("bash: what a command writes", () => {
	it("judges a command on the paths it writes, not on what it reads", async () => {
		const { pi } = enforce();
		await pi.user("Read-only for now, just investigate.");
		assert.equal(await blocked(pi, "bash", { command: "mkdir -p /tmp/probe && cp src/a.ts /tmp/probe/" }), false);
		assert.equal(await blocked(pi, "bash", { command: "cp src/a.ts src/b.ts" }), true);
	});

	it("reading test/ into another file is not modifying test/; writing into it is", async () => {
		const { pi } = enforce();
		await pi.user("Don't modify anything in test/.");
		assert.equal(await blocked(pi, "bash", { command: "grep -rn foo test/ > notes.txt" }), false);
		assert.equal(await blocked(pi, "bash", { command: "cp test/fixture.json /tmp/fixture.json" }), false);
		for (const command of ["echo x > test/a.test.ts", "cd test && rm a.test.ts", "find test -name '*.snap' -delete", "mv test/a.test.ts /tmp/", "git checkout test/a.test.ts"]) {
			assert.equal(await blocked(pi, "bash", { command }), true, command);
		}
	});

	it("echo/printf text is not an operation, unless a shell runs it", async () => {
		const { pi } = enforce();
		await pi.user("Don't push.");
		assert.equal(await blocked(pi, "bash", { command: "echo remember to git push later" }), false);
		for (const command of ["echo 'git push' | sh", "bash -c 'git push'", "ssh host 'cd app && git push'", "git commit -am x && git push"]) {
			assert.equal(await blocked(pi, "bash", { command }), true, command);
		}
	});
});
