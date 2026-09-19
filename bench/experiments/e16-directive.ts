// E16: rules found by the parser in sentences that are not rules for the assistant (explanations, questions,
// code/docs to write, reassurance). Can one Jev choice tell them apart without dropping real rules?
//   node bench/experiments/e16-directive.ts
import { JevJudge, resolveTransport } from "../../src/judge.ts";
import { parseMessage } from "../../src/rules.ts";
import { PolicyEngine, describe } from "../../src/policy.ts";
import { DIRECTIVE, directiveQuestion } from "../../src/understand.ts";

const judge = new JevJudge(resolveTransport()!);
// not rules for the assistant
export const NOT_RULES = [
	"Explain what git push --force does and why people say never do it.",
	"I don't mind if you edit the tests.",
	"Don't be afraid to install packages if you need them.",
	"Don't hesitate to refactor src/utils if it helps.",
	"Add a CONTRIBUTING section: contributors must not modify generated files in dist/.",
	"This function doesn't modify any files, it just reads the config.",
	"Can you write a pre-push hook that blocks pushes when tests fail?",
	"Add a --no-install flag that skips installing dependencies.",
	"The ticket says the API must never write to the audit table directly; how would you design that?",
	"这个函数不会修改文件，只读配置。",
	"为什么大家说不要 force push？解释一下。",
	"帮我写个 git hook，禁止直接 push 到 main。",
	"文档里写上：不要手动修改 dist 目录。",
	"写个函数，dryRun 的时候不要写文件。",
	"不要客气，想改哪里改哪里。",
	"我不介意你改测试。",
	"lint 规则加一条：禁止修改 readonly 属性。",
];
// real rules for the assistant
export const RULES = [
	"Don't push.",
	"Don't modify anything in test/.",
	"Why is it failing? Don't change the tests though.",
	"Explain the bug first, and don't touch src/ yet.",
	"Please don't modify dist/, it's generated.",
	"I don't want any new dependencies in this project.",
	"Write the hook, but don't commit anything yet.",
	"Read-only for now, just investigate.",
	"You must not edit package.json.",
	"No new packages. Use what's already there.",
	"别动 package.json。",
	"先别提交，我要先看一下。",
	"写个脚本，但别装新包。",
	"为什么测试挂了？先别改测试。",
	"只读，先分析一下原因。",
	"不要 push，我来 review。",
	"帮我修 bug，但是 dist 目录不要动。",
];

async function run(set: string[], expectRule: boolean) {
	let wrong = 0, dropped = 0, n = 0;
	for (const m of set) {
		const e = new PolicyEngine();
		const specs = parseMessage(m, 0).flatMap((o: any) => (o.op === "add" && o.spec.effect !== "ALLOW" ? [o.spec] : []));
		if (!specs.length) { console.log(`   (parser found nothing) ${m}`); continue; }
		const qs: Record<string, any> = {};
		specs.forEach((s, i) => (qs[`d${i}`] = directiveQuestion(describe({ ...s, id: "x", exceptions: [], status: "active", provenance: { by: "rule", at: 0 } } as any))));
		const r = await judge.decide({ new_user_message: m }, qs, AbortSignal.timeout(10000));
		specs.forEach((s, i) => {
			n++;
			const a: any = (r as any)[`d${i}`];
			const p = a?.probabilities?.not_a_rule ?? 0, c = a?.confidence ?? 0;
			const drop = p >= 0.9 && c >= 0.8;
			if (drop) dropped++;
			const bad = expectRule ? drop : !drop;
			if (bad) wrong++;
			console.log(`${bad ? " ✗" : "  "} not_a_rule=${p.toFixed(2)} conf=${c.toFixed(2)} ${a?.choice ?? "?"}  ${m.slice(0, 60)}  [${describe({ ...s, id: "x", exceptions: [], status: "active", provenance: {} } as any)}]`);
		});
	}
	return { wrong, dropped, n };
}
console.log("-- not rules (should drop)");
const a = await run(NOT_RULES, false);
console.log("-- real rules (must keep)");
const b = await run(RULES, true);
console.log(`\nnot-rules dropped: ${a.dropped}/${a.n}   real rules dropped: ${b.dropped}/${b.n}`);
