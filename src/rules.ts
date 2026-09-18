import type { PolicyAction, PolicyOp, PolicySpec, Scope } from "./policy.ts";

// Deterministic message → policy ops. Narrow on purpose: an unrecognised instruction is better than
// a phantom one. Jev covers paraphrases and lifts this misses (see understand.ts).

interface Target {
	action: PolicyAction;
	resource: string;
}

const NOT_A_POLICY = /don'?t worry|don'?t know|don'?t forget|never mind(?!.*(?:permission|allow|exception))|别担心|不要紧|别客气|别急|别忘了|不要忘了?|记得/i;

const NEG_EN = /\b(?:don'?t|do not|never|must not|mustn'?t|shouldn'?t|should not|cannot|can'?t|no longer|stop|avoid)\b|\bno\s+(?:new\s+|more\s+)?(?:changes|edits|modifications|deps|dependencies|packages|pushing|push(?:es)?|commits?)\b|\bleave\b.+\balone\b|\bhands off\b|\bread[- ]only\b|\b(?:only|just) (?:review|look|read)\b/i;
// 别 is only a prohibition before a verb: not in 别人 / 别的 / 别处 (others) or 区别 / 特别 / 识别 / 类别 … (real session: E10)
const BIE = "(?<![区特识类级差性告分派辨鉴甄判])别(?![人的处名墅致扭具])";
const NEG_ZH = new RegExp(`不要|${BIE}|不许|不准|禁止|不能|不可以|不得|切勿|请勿|只读|只看|不用改|保持不变`);
const ALLOW_EN =
	/\b(?:you can|you may|feel free to|go ahead|it'?s (?:fine|ok|okay)|is (?:fine|ok|okay)|are (?:fine|ok|okay)|are allowed|is allowed|allowed to|permission to|now (?:edit|fix|implement|apply|change|modify|write))\b|\b(?:apply|make) (?:the )?(?:fix|fixes|changes)\b/i;
const ALLOW_ZH = /(?<![不别])可以|允许|没问题|随便|放开|解禁|(?:现在|开始|直接|去)(?:改|修|动手|写|实现)/;
const EDIT_VERB = /\b(?:edit|modify|change|touch|write|alter|implement|fix|apply|delete|remove|rewrite|update)\b|改|修|动|写|实现|删/i;

const REVOKE_ALLOW = /(?:取消|撤销|收回|作废|撤回).{0,8}(?:允许|许可|授权|例外)|(?:允许|许可|授权|例外).{0,4}(?:取消|撤销|收回|作废)|\b(?:revoke|cancel|withdraw|take back)\b.{0,24}\b(?:permission|exception|that)\b/i;
const CONFIRM = /\b(?:ask|check with|confirm with) me\b|\bask (?:me )?(?:first|before)\b|先问我|问一下我|问过我|征求我|经我(?:同意|确认)|需要我确认|先跟我确认|等我确认/i;
const BEFORE_EN = /\b(?:run|execute) (?:the )?(?:tests?|test suite)\b.{0,20}\bbefore\b.{0,20}\b(push|commit)|\bbefore\b.{0,20}\b(push|commit)\w*\b.{0,24}\b(?:run|execute) (?:the )?tests?\b/i;
const BEFORE_ZH = /(push|推送|提交|commit)\s*(?:代码)?\s*(?:之)?前.{0,6}(?:跑|运行|执行).{0,4}测试|(?:先|要先).{0,4}(?:跑|运行|执行).{0,4}测试.{0,6}(?:再|才能|然后).{0,4}(push|推送|提交|commit)/i;

const SCOPE_ONCE = /这一次|这次|本次|仅此一次|就一次|just this once|this (?:one )?time\b|one[- ]time\b|\bonce\b/i;
const SCOPE_RUN = /这一轮|本轮|这轮|这一步|this (?:run|turn|round|step)\b/i;
const SCOPE_GOAL = /这个任务|本任务|这个需求|for this task\b|during this task\b/i;

const EXPLICIT_PATH = /(?:^|[\s\x60'"(（「“])((?:\.{0,2}\/)?[\w@.-]*[\w-]\/[\w./@-]*|[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s\x60'"),.，。;；:：)）」”!?！？])/g;
const BARE_ZH_TOKEN = /(?<![\w./@-])([A-Za-z_][\w-]{1,40})(?![\w./@-])/g;
const BARE_EN_AFTER_VERB = /\b(?:touch|edit|modify|change|alter|delete|rewrite)\s+(?:the\s+)?([A-Za-z_][\w-]{1,40})(?:\s+(?:dir|directory|folder|module|package))?\b/gi;
const NOT_PATH_WORDS = new Set(
	"ok okay api apis git push pushing npm pnpm yarn pip test tests spec specs pr ci bug bugs deps dependencies dependency package packages the a an any anything everything file files code it this that them these those repo codebase main master prod production readme docs doc all now yet later again something stuff more here there please freely first still too read-only readonly mode review fix".split(" "),
);
const GENERIC_MODIFY = /\b(?:files?|code|anything|everything|the repo|codebase|the project)\b|文件|代码|任何|全部|所有|其他|其它|都|项目|仓库|只读|只看|read[- ]only|hands off|(?:only|just) (?:review|look|read)|\bno (?:code |file )?changes\b/i;

/** Remove things that are not the user's own instruction: code blocks and reported speech. */
export function ownWords(text: string): string {
	return (
		text
			.replace(/```[\s\S]*?```/g, " ")
			// quoted speech after a reporting verb: `my colleague said "don't edit anything"`
			.replace(/(\b(?:said|says|wrote|writes|told (?:me|us)|mentioned|claims?)\b|说过?|写着|写道|提到|表示|原话是)\s*[:：,，]?\s*(["“'「『])[^"”'」』]*(["”'」』])/gi, "$1 <quote>")
	);
}

function sentences(text: string): string[] {
	return text
		.split(/(?<=[。！？；\n])|(?<=[.!?;])(?=\s|$)/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** "A, but B" → [A, B]. Exceptions and narrowings live in the second half. */
function clauses(sentence: string): string[] {
	return sentence
		.split(/[,，;；]?\s*(?:\bbut\b|\bhowever\b|但是|不过|但(?!愿))/i)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** A clause that reports someone else's words without quoting them ("the README says don't edit"). */
function isReported(clause: string): boolean {
	return /\b(?:said|says|wrote|writes|mentioned|claims?)\b|(?:他|她|同事|别人|文档|README|注释|文件里?|上面|代码里).{0,6}(?:说|写着|写道|提到)/i.test(clause);
}

function detectScope(clause: string): Scope {
	if (SCOPE_ONCE.test(clause)) return "once";
	if (SCOPE_RUN.test(clause)) return "run";
	if (SCOPE_GOAL.test(clause)) return "goal";
	return "session";
}

function pathTargets(clause: string): string[] {
	const out = new Set<string>();
	// a path at the end of a sentence keeps the sentence's full stop: "…touch src/auth/token.ts."
	for (const m of clause.matchAll(EXPLICIT_PATH)) out.add(m[1].replace(/[.,;:!?]+$/, ""));
	if (/[一-鿿]/.test(clause)) {
		for (const m of clause.matchAll(BARE_ZH_TOKEN)) if (!NOT_PATH_WORDS.has(m[1].toLowerCase())) out.add(m[1]);
	} else {
		for (const m of clause.matchAll(BARE_EN_AFTER_VERB)) if (!NOT_PATH_WORDS.has(m[1].toLowerCase())) out.add(m[1]);
	}
	// "src/auth" also yields "src/auth" only, not "src": keep the longest overlapping forms
	return [...out].filter((p) => ![...out].some((q) => q !== p && q.length > p.length && q.includes(p) && !p.includes("/") && q.startsWith(p)));
}

/** Explicit paths mentioned in a message's own words (for Jev's EXCEPTION/NARROW deltas, which carry no resource). */
export function mentionedPaths(text: string): string[] {
	return [...new Set(sentences(ownWords(text)).flatMap((s) => [...s.matchAll(EXPLICIT_PATH)].map((m) => m[1].replace(/[.,;:!?]+$/, ""))))];
}

function detectTargets(clause: string): Target[] {
	const t: Target[] = [];
	if (/\bpush(?:ing|ed|es)?\b|推送|推到|推上去/i.test(clause)) t.push({ action: "git_push", resource: "*" });
	if (/\bcommit(?:ting|ted|s)?\b|提交/i.test(clause)) t.push({ action: "git_commit", resource: "*" });
	if (/dependenc|\bdeps\b|\bpackages?\b(?![.\w])|\blibrar(?:y|ies)\b|依赖|第三方库|装包|(?:装|安装|引入|加)(?:新的?)?(?:包|库)/i.test(clause)) t.push({ action: "install_deps", resource: "*" });
	if (/\b(?:tests?|specs?|test files?)\b|测试|单测/i.test(clause) && !/\b(?:run|execute)\b.{0,12}\btests?\b|跑.{0,4}测试/i.test(clause)) {
		t.push({ action: "modify", resource: "tests" });
	}
	for (const p of pathTargets(clause)) t.push({ action: "modify", resource: p });
	if (t.length === 0 && GENERIC_MODIFY.test(clause)) t.push({ action: "modify", resource: "*" });
	return t;
}

/** "不要改" / "don't change anything" / "还是不可以改": a deny with an edit verb and nothing else in it. */
function isBareEdit(clause: string): boolean {
	const rest = clause
		.toLowerCase()
		.replace(/don'?t|do not|never|please|still|yet|now|again|anything|any|at all|for now|\b(?:edit|modify|change|touch|write|alter)\b/g, " ")
		.replace(/不要|别|不许|不准|禁止|不能|不可以|不得|还是|先|再|也|都|了|吧|啊|呢|哦|任何|东西|改动|修改|改|动|写/g, " ")
		.replace(/[\s,，.。!！?？~～…]+/g, "");
	return rest.length === 0 && EDIT_VERB.test(clause);
}

function spec(effect: PolicySpec["effect"], target: Target, scope: Scope, quote: string, at: number, extra: Partial<PolicySpec> = {}): PolicyOp {
	return { op: "add", spec: { effect, action: target.action, resource: target.resource, scope, sourceQuote: quote, by: "rule", at, ...extra } };
}

/** Parses one user message into policy ops. Pure: same text → same ops. */
export function parseMessage(text: string, at: number): PolicyOp[] {
	const ops: PolicyOp[] = [];
	for (const sentence of sentences(ownWords(text))) {
		const quote = sentence;
		for (const raw of clauses(sentence)) {
			let clause = raw;
			if (NOT_A_POLICY.test(clause) || isReported(clause)) continue;
			const scope = detectScope(clause);

			// "run the tests before pushing" / "push 前先跑测试"
			const before = BEFORE_EN.exec(clause) ?? BEFORE_ZH.exec(clause);
			if (before) {
				const verb = (before[1] ?? before[2] ?? "").toLowerCase();
				const action: PolicyAction = /commit|提交/.test(verb) ? "git_commit" : "git_push";
				ops.push(spec("REQUIRE_BEFORE", { action, resource: "*" }, scope, quote, at, { prerequisite: "tests" }));
				continue;
			}

			// "don't modify anything except notes.txt" / "除了 notes.txt 其他都别改"
			const except = /\b(?:except(?: for)?|other than|apart from)\s+(.+?)(?=$|[,，;；])|除了\s*(.+?)\s*(?:之外|以外)?(?=[,，;；]|其他|其它|都|$)|(\S+)\s*除外/i.exec(clause);
			if (except && (NEG_EN.test(clause) || NEG_ZH.test(clause))) {
				const part = except[1] ?? except[2] ?? except[3] ?? "";
				for (const p of pathTargets(` ${part} `)) ops.push(spec("ALLOW", { action: "modify", resource: p }, scope, quote, at));
				clause = clause.replace(except[0], " ");
			}

			const deny = NEG_EN.test(clause) || NEG_ZH.test(clause);
			const targets = detectTargets(clause);

			if (CONFIRM.test(clause)) {
				for (const t of targets.length ? targets : [{ action: "modify" as const, resource: "*" }]) ops.push(spec("REQUIRE_CONFIRMATION", t, scope, quote, at));
				continue;
			}
			// "刚才允许的取消，继续不要改测试": the new deny supersedes the permission by itself
			if (REVOKE_ALLOW.test(clause) && !(deny && targets.length)) {
				ops.push({ op: "revoke_allow", quote, at, by: "rule" });
				continue;
			}
			if (deny) {
				if (targets.length) for (const t of targets) ops.push(spec("DENY", t, scope, quote, at));
				else if (isBareEdit(clause)) ops.push(spec("DENY", { action: "modify", resource: "*" }, scope, quote, at));
				else if (clause.length <= 240) ops.push(spec("DENY", { action: "custom", resource: clause.trim() }, scope, quote, at));
				continue;
			}
			if (ALLOW_EN.test(clause) || ALLOW_ZH.test(clause)) {
				if (targets.length) for (const t of targets) ops.push(spec("ALLOW", t, scope, quote, at));
				else if (EDIT_VERB.test(clause)) ops.push(spec("ALLOW", { action: "modify", resource: "*" }, scope, quote, at));
			}
		}
	}
	return ops;
}
