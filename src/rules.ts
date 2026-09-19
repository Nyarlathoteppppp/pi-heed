import type { PolicyAction, PolicyOp, PolicySpec, Scope } from "./policy.ts";

// Deterministic message → policy ops. Narrow on purpose: an unrecognised instruction is better than
// a phantom one. Jev covers paraphrases and lifts this misses (see understand.ts).

interface Target {
	action: PolicyAction;
	resource: string;
}

const NOT_A_POLICY =
	/don'?t worry|don'?t know|don'?t forget|never mind(?!.*(?:permission|allow|exception))|don'?t (?:hesitate|be afraid|be shy)|\bI don'?t mind\b|\bno need to ask\b|read[- ]only [\w -]{1,30}\b(?:is|are) (?:allowed|fine|ok)\b|别担心|不要担心|不用担心|不要紧|别客气|不要客气|不用客气|不介意|别怕|不要怕|别急|别忘了|不要忘了?|记得|(?:不能|不要|别|不可以|不应该?)只|\bnot only\b|\bdon'?t (?:just|only)\b/i;

// "stop" / "avoid" only with an action ("stop editing"), not as a word ("Stop 收尾", the Stop button)
const NEG_EN = /\b(?:don'?t|do not|never|must not|mustn'?t|shouldn'?t|should not|cannot|can'?t|no longer)\b|\b(?:stop|avoid)\s+\w+ing\b|\bno\s+(?:new\s+|more\s+)?(?:changes|edits|modifications|deps|dependencies|packages|pushing|push(?:es)?|commits?)\b|\bleave\b.+\balone\b|\bhands off\b|\bread[- ]only\b|\b(?:only|just) (?:review|look|read)\b/i;
// 别 is only a prohibition before a verb: not in 别人 / 别的 / 别处 (others) or 区别 / 特别 / 识别 / 类别 … (real session: E10)
const BIE = "(?<![区特识类级差性告分派辨鉴甄判])别(?![人的处名墅致扭具])";
// 只读 / 只看 as a mode ("只读，先分析", "只读模式"), not as a verb with an object ("只读配置": reads only the config)
const MODE_END = "(?=$|[\\s，。,.!！；;:：?？、]|模式|就|吧|啊|哈|呀|一下|看看|不|别|先|的方式|审查|审核|检查|核对|分析|调研|排查)";
const NEG_ZH = new RegExp(`不要|${BIE}|不许|不准|禁止|不能|不可以|不得|切勿|请勿|只读${MODE_END}|只看${MODE_END}|不用改|保持不变`);
const ALLOW_EN =
	/\b(?:you can|you may|feel free to|go ahead|it'?s (?:fine|ok|okay)|is (?:fine|ok|okay)|are (?:fine|ok|okay)|are allowed|is allowed|allowed to|permission to|now (?:edit|fix|implement|apply|change|modify|write))\b|\b(?:apply|make) (?:the )?(?:fix|fixes|changes)\b/i;
const ALLOW_ZH = /(?<![不别])可以|允许|没问题|随便|放开|解禁|(?:现在|开始|直接|去)(?:改|修|动手|写|实现)/;
/** Verbs that act on files. A clause must have one before its words are read as paths (real session: E15). */
const PROTECT_VERB = /\b(?:edit|edits|editing|modify|modifying|change|changing|touch|touching|write|writing|alter|delete|deleting|remove|rename|overwrite)\b|改|动|碰|删|写入|覆盖|重命名/i;
const READ_ONLY_PHRASE = /只读(?=$|[\s，。,.!！；;:：?？、]|模式|就|吧|啊|哈|呀|一下|看看|不|别|先|的方式|审查|审核|检查|核对|分析|调研|排查)|只看(?=$|[\s，。,.!！；;:：?？、]|模式|就|吧|啊|哈|呀|一下|看看|不|别|先|的方式)|只审查|read[- ]only|hands off|(?:only|just) (?:review|look|read)|\bno (?:code |file )?changes\b/i;
/** A bare word in Chinese text is a path only right next to an edit verb: "改 src", "src 不能改", "别动 src". */
const ZH_TOKEN_NEAR_VERB =
	/(?:改|动|碰|删|修改|写入)\s*([A-Za-z_][\w-]{1,40})(?![\w./@-])(?!\s*的)|(?<![\w./@-])([A-Za-z_][\w-]{1,40})\s*(?:目录|文件夹|文件)?\s*(?:里的?|下的?)?\s*(?:都|也|还是)?\s*(?:不能|不要|别|不许|不准|不可以|可以|能)?\s*(?:改(?![写成变为进善正])|动|碰|删|修改)/g;
const EDIT_VERB = /\b(?:edit|modify|change|touch|write|alter|implement|fix|apply|delete|remove|rewrite|update)\b|改|修|动|写|实现|删/i;

const REVOKE_ALLOW = /(?:取消|撤销|收回|作废|撤回).{0,8}(?:允许|许可|授权|例外)|(?:允许|许可|授权|例外).{0,4}(?:取消|撤销|收回|作废)|\b(?:revoke|cancel|withdraw|take back)\b.{0,24}\b(?:permission|exception|that)\b/i;
const CONFIRM = /\b(?:ask|check with|confirm with) me\b|\bask (?:me )?(?:first|before)\b|先问我|问一下我|(?:先|要|得|必须|需要)问过我|征求我|经我(?:同意|确认)|需要我确认|先跟我确认|等我确认/i;
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
// 其他 / 其它 alone ("先别动其他的": leave the rest alone) is relative to the task, not a blanket; with 除了 it is handled as an exception
const GENERIC_MODIFY = /\b(?:files?|code|anything|everything|the repo|codebase|the project)\b|文件|代码|任何|全部|所有|都|项目|仓库|只读|只看|read[- ]only|hands off|(?:only|just) (?:review|look|read)|\bno (?:code |file )?changes\b/i;

/**
 * 文件 / 代码 mean "all files" only after a verb or a quantifier (改文件, 任何文件, 所有代码). After a noun or 的 they
 * name particular files (我的卡片文件, 我的代码): that is for Jev to judge, not a blanket read-only (replay, E17).
 */
function unqualified(clause: string): string {
	return clause.replace(/文件|代码/g, (m, offset: number) => (offset === 0 || /[改动删写碰修何有部目库\s，,。:：、]/.test(clause[offset - 1]) ? m : " "));
}

/** Remove things that are not the user's own instruction: code blocks and reported speech. */
export function ownWords(text: string): string {
	return (
		text
			.replace(/```[\s\S]*?```/g, " ")
			// 「…」『…』 name or quote something ("「中文讲课禁简繁」如果没问过我…"): not the user's own rule
			.replace(/「[^」]*」|『[^』]*』/g, " <quote> ")
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
		// "不要修改文件、不要提交或推送" is two bans: each gets its own targets
		// (a ban that is content to write stays whole, so "写个 hook，禁止 push" is still seen as authored)
		.flatMap((c) => (isAuthored(c) ? [c] : c.split(/[、,，]\s*(?=(?:也|并且|and\s+|or\s+)?(?:不要|别|不许|不能|禁止|不得|don'?t\b|do not\b|never\b|no\s))/i)))
		.map((s) => s.trim())
		.filter(Boolean);
}

/** A clause that reports someone else's words without quoting them ("the README says don't edit"). */
/** A hold: "not yet", until the user says so. It ends at their go-ahead instead of lasting the session. */
const HOLD = /先(?:别|不要|不|暂停)|先(?:看看?|想想?|讨论|分析|了解|核对|确认|研究|检查|说说?|告诉我|回答|理解)|暂时(?:别|不要|不)|现在还?(?:不许|不能|不要|别|不用)|还不(?:许|能|要|用)|等我|在我(?:没有?|还没)?(?:说|确认|同意|批准|看过|点头)|我(?:说|确认|同意)(?:了)?(?:之前|以前|前|再)|(?:核对|讨论|确认|商量|看看?)(?:一下)?(?:之前|前|再)|\b(?:for now|yet|hold off|until I|before I (?:say|confirm|approve|review))\b|\bwait (?:for|until)\b/i;
/** Verbs of doing the work: a hold on one of these, with no object, holds all changes ("先别做", "先别实施"). */
const WORK_VERB = /改|做|实施|实现|动手|执行|开始|写|修|弄|搞|提交|\b(?:edit|change|modify|touch|implement|start|do (?:it|anything)|write|build|fix)\b/i;
/**
 * The user says to proceed: ends every hold from earlier messages. Only unambiguous imperatives; "好改吗"
 * (is it easy to change?) and "你打算怎么改" (how would you change it?) are not. Jev handles the rest.
 */
const GO_AHEAD_ZH =
	/(?:改|做|修|弄|写|实施|执行|动手|搞|实现|干|开工|改进|优化|修复|处理|开始|继续)(?:一下)?吧(?![吗？?])|继续(?:做|改|实施|实现|修)(?![吗？?])|确认并?开始|(?:^|[\s，。,!！]|我们|然后|那就|就|现在)开始(?:做|改|实施|实现|动手|干|修|写|了)?吧?(?=$|[\s，。,!！])|(?:按|照)(?:你的|这个|你说的|这样|上面的?)(?:方案|思路|计划|来)?(?:做|改|来|办|实施|执行)|就这么(?:做|改|办)|可以开始了?|可以(?:动手|改了|做了)|开干|动手吧/i;
const GO_AHEAD_EN = /\b(?:go ahead|do it|proceed|ship it|make (?:the|those|these) changes|implement it|start (?:implementing|coding|now|the work)|let'?s do (?:it|this)|you can (?:start|proceed|go ahead|begin)|green light)\b/i;

function isGoAhead(clause: string): boolean {
	if (/[?？吗]\s*$/.test(clause)) return false;
	if (!(GO_AHEAD_ZH.test(clause) || GO_AHEAD_EN.test(clause))) return false;
	// "先别开始做" / "don't go ahead yet"
	return !(NEG_EN.test(clause) || NEG_ZH.test(clause));
}

function isReported(clause: string): boolean {
	// "as I said, don't push" is still the user's own rule
	if (/\b(?:I|we)(?:'ve| have)? (?:said|told you|mentioned)\b|我(?:刚才?|之前|上面)?(?:说|讲|提)过?/i.test(clause)) return false;
	return (
		/\b(?:said|says|wrote|writes|mentioned|claims?)\b|\b(?:people|they|everyone|folks|some|others)\s+(?:say|recommend|suggest|warn)\b/i.test(clause) ||
		/(?:他|她|同事|别人|大家|人们|有人|网上|官方|他们|文档|README|注释|文件里?|上面|代码里).{0,6}(?:说|写着|写道|提到|建议|讲)/i.test(clause)
	);
}

/**
 * A ban that is content to write (a hook, a docs line, a lint rule) or a rule for other people or for the code
 * ("contributors must not…", "the API must never…"), not a restriction on the assistant (E16).
 */
function isAuthored(clause: string): boolean {
	// the content being written comes before the ban it contains ("写个 hook，禁止 push"), not after ("不要改 X，写个脚本")
	const neg = clause.search(new RegExp(`${NEG_EN.source}|${NEG_ZH.source}`, "i"));
	const authoring = (re: RegExp) => {
		const m = re.exec(clause);
		return !!m && (neg < 0 || m.index < neg);
	};
	return (
		authoring(/\b(?:write|add|create|implement|make|generate|document|put)\b[^.]{0,60}?\b(?:hook|rule|section|check|guard|validation|policy|docs?|documentation|comment|readme|contributing|flag|option|linter?)\b/i) ||
		/\b(?:contributors|users|people|developers|clients|callers|the (?:api|function|code|service|bot|app|script|server|tool))\b[^.]{0,30}\b(?:must|should|shall|may|can|will)(?:\s+not|n'?t|\s+never)\b/i.test(clause) ||
		authoring(/(?:写|加|实现|生成|做|建)一?[个条段套]?.{0,20}?(?:hook|钩子|函数|规则|脚本|检查|校验|说明|注释|提示)|(?:文档|注释|README|提示词|说明|规范)(?:里|中|上)?(?:写|加|注明|说明)|(?:规则|lint|配置).{0,4}加一?[条个]/i)
	);
}

function detectScope(clause: string): Scope {
	if (SCOPE_ONCE.test(clause)) return "once";
	if (SCOPE_RUN.test(clause)) return "run";
	if (SCOPE_GOAL.test(clause)) return "goal";
	return "session";
}

function pathTargets(clause: string, requireVerb = true): string[] {
	const out = new Set<string>();
	if (requireVerb && !PROTECT_VERB.test(clause)) return [];
	// a path at the end of a sentence keeps the sentence's full stop: "…touch src/auth/token.ts."
	for (const m of clause.matchAll(EXPLICIT_PATH)) out.add(m[1].replace(/[.,;:!?]+$/, ""));
	if (/[一-鿿]/.test(clause)) {
		for (const m of clause.matchAll(ZH_TOKEN_NEAR_VERB)) {
			const tok = m[1] ?? m[2];
			if (tok && !NOT_PATH_WORDS.has(tok.toLowerCase())) out.add(tok);
		}
	} else {
		for (const m of clause.matchAll(BARE_EN_AFTER_VERB)) if (!NOT_PATH_WORDS.has(m[1].toLowerCase())) out.add(m[1]);
	}
	// "src/auth" also yields "src/auth" only, not "src": keep the longest overlapping forms
	return [...out].filter((p) => ![...out].some((q) => q !== p && q.length > p.length && q.includes(p) && !p.includes("/") && q.startsWith(p)));
}

/** Explicit paths mentioned in a message's own words (for Jev's EXCEPTION/NARROW deltas, which carry no resource). */
export function mentionedPaths(text: string): string[] {
	return [...new Set(sentences(ownWords(text)).flatMap((s) => pathTargets(s, false)))];
}

function detectTargets(clause: string, allow = false): Target[] {
	const t: Target[] = [];
	if (/\bpush(?:ing|ed|es)?\b|推送|推到|推上去/i.test(clause)) t.push({ action: "git_push", resource: "*" });
	if (/\bcommit(?:ting|ted|s)?\b|提交/i.test(clause)) t.push({ action: "git_commit", resource: "*" });
	// 依赖 is also the verb "depend on" (所有依赖旧状态的结果): Chinese needs an install/add context
	if (
		// English needs an add/install/new context too: "dependency graph" is not about installing anything
		/\b(?:add|adding|install|installing|introduce|pull in|new|extra|additional|any)\b[^.。]{0,24}\b(?:dependenc\w*|deps|packages?(?!\.?\w)|librar(?:y|ies))\b|\bno\s+(?:new\s+|more\s+)?(?:dependenc\w*|deps|packages|libraries)\b/i.test(clause) ||
		/(?:装|安装|引入|加|添加|新增|增加)\s*(?:新的?|任何|额外的?|第三方)?\s*(?:依赖|包|库)|新依赖|第三方(?:依赖|库|包)|依赖包|装包/.test(clause)
	) {
		t.push({ action: "install_deps", resource: "*" });
	}
	// the tests themselves, next to a verb that changes them: not 测试宿主 / 测试脚本 / "run the tests" (replay, E17)
	const TESTS_NOUN = String.raw`(?:(?:the|any|our|my)\s+)?(?:tests?|specs?|test (?:files?|cases?|suites?))\b`;
	const testsChanged =
		new RegExp(String.raw`\b(?:edit|modify|change|touch|delete|remove|rewrite|update|alter|weaken|skip)\b[^.,;]{0,20}?\b${TESTS_NOUN}|\b${TESTS_NOUN}[^.,;]{0,12}\b(?:alone|untouched|as (?:they are|is))\b|\bhands off\b[^.,;]{0,12}\btests?\b|\bno test (?:changes|edits)\b`, "i").test(clause) ||
		/(?:改|动|碰|删|修改|重写|改动)[^，。,.；;]{0,6}?(?:测试|单测)(?!宿主|脚本|环境|服务器?|数据|账号|结果|报告|命令)|(?:测试|单测)(?:用例|文件|代码|目录)?[^，。,.；;]{0,6}?(?:改|动|碰|删|修改)/i.test(clause);
	if (testsChanged && !/\b(?:run|execute)\b.{0,12}\btests?\b|跑.{0,4}测试/i.test(clause)) {
		t.push({ action: "modify", resource: "tests" });
	}
	for (const p of pathTargets(clause, !allow)) t.push({ action: "modify", resource: p });
	// "所有…都要检查" is not read-only: a blanket target needs a file verb or a read-only phrase
	if (t.length === 0 && GENERIC_MODIFY.test(unqualified(clause)) && (allow || PROTECT_VERB.test(clause) || READ_ONLY_PHRASE.test(clause))) t.push({ action: "modify", resource: "*" });
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

/**
 * A long message with several paragraphs is mostly pasted material (a spec, another agent's report, a prompt
 * written for someone else). Only the user's own framing around it, the first and last short paragraphs, is
 * parsed; Jev still reads the whole message (replay: pasted prompts for other AIs became bans, E17).
 */
export function framing(text: string): string {
	const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
	if (text.length <= 600 || paragraphs.length < 3) return text;
	const short = (p: string | undefined) => (p && p.length <= 300 ? p : "");
	return [short(paragraphs[0]), short(paragraphs.at(-1))].filter(Boolean).join("\n\n");
}

/**
 * The middle of a long pasted message. It can hold the user's own instructions between pasted material: its bans
 * become candidates that count only once Jev confirms they restrict the assistant (never without Jev).
 */
export function pastedBody(text: string): string {
	const kept = framing(text);
	if (kept === text) return "";
	const framed = new Set(kept.split(/\n\n/));
	return text
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter((p) => p && !framed.has(p))
		.join("\n\n");
}

/** Parses one user message into policy ops. Pure: same text → same ops. `whole`: parse all of it, pasted or not. */
export function parseMessage(text: string, at: number, whole = false): PolicyOp[] {
	const ops: PolicyOp[] = [];
	for (const sentence of sentences(ownWords(whole ? text : framing(text)))) {
		const quote = sentence;
		// "只读审查，不要修改文件、不要提交或推送": every ban in a read-only or "not yet" sentence is part of that hold
		const sentenceHold = HOLD.test(sentence) || READ_ONLY_PHRASE.test(sentence);
		for (const raw of clauses(sentence)) {
			let clause = raw;
			// a go-ahead with an object ("现在测试可以改了") is a permission for that object, handled below
			if (isGoAhead(clause) && !detectTargets(clause, true).length) {
				ops.push({ op: "go_ahead", quote, at, by: "rule" });
				continue;
			}
			if (NOT_A_POLICY.test(clause) || isReported(clause) || isAuthored(clause)) continue;
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
				for (const p of pathTargets(` ${part} `, false)) ops.push(spec("ALLOW", { action: "modify", resource: p }, scope, quote, at));
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
				const hold = sentenceHold || HOLD.test(clause);
				// read-only and holds end at the user's go-ahead; a ban on one file, a push or a dependency lasts
				// a push reaches other people: a go-ahead to make changes is not a go-ahead to push
				const until = (t: Target): Partial<PolicySpec> => ((hold && t.action !== "git_push") || (t.action === "modify" && t.resource === "*") ? { until: "go_ahead" } : {});
				if (targets.length) for (const t of targets) ops.push(spec("DENY", t, scope, quote, at, until(t)));
				else if (isBareEdit(clause) || (hold && WORK_VERB.test(clause))) ops.push(spec("DENY", { action: "modify", resource: "*" }, scope, quote, at, { until: "go_ahead" }));
				else if (clause.length <= 240) ops.push(spec("DENY", { action: "custom", resource: clause.trim() }, scope, quote, at, hold ? { until: "go_ahead" } : {}));
				continue;
			}
			if (ALLOW_EN.test(clause) || ALLOW_ZH.test(clause)) {
				// a permission may name a path without a verb ("但 notes.txt 可以")
				const allowTargets = detectTargets(clause, true);
				if (allowTargets.length) for (const t of allowTargets) ops.push(spec("ALLOW", t, scope, quote, at));
				else if (EDIT_VERB.test(clause)) ops.push(spec("ALLOW", { action: "modify", resource: "*" }, scope, quote, at));
			}
		}
	}
	return ops;
}
