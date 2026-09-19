// The main model keeps the ledger: it understands the user, records the hard rules they state and lifts them when
// they say so. pi-heed does not interpret; it checks the receipt (the user's exact words, in a message they typed)
// and enforces what is recorded at tool-call time.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "./actions.ts";
import { ask, type ChoiceAnswer, type ChoiceQuestion, type Judge } from "./judge.ts";
import { describe, type Policy, type PolicyOp, type PolicySpec } from "./policy.ts";

export interface LedgerHost {
	judge: Judge | undefined;
	timeoutMs: number;
	/** Every user-role message so far, by index (what `at` refers to). */
	messages(): readonly string[];
	/** Indexes of messages another extension injected: never evidence. */
	injected(): ReadonlySet<number>;
	policy(id: string): Policy | undefined;
	/** Restrictions a lasting permission would end or carve into. */
	affectedBy(spec: Pick<PolicySpec, "action" | "resource">): Policy[];
	/** Applies and persists ops, returns the engine's lines. */
	commit(ops: PolicyOp[]): string[];
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The latest message the user typed (not injected) that contains `quote`, at or after `after`. */
export function findQuote(host: LedgerHost, quote: string, after = -1): number | undefined {
	const q = squash(quote);
	if (q.length < 2) return undefined;
	const msgs = host.messages();
	for (let at = msgs.length - 1; at > after; at--) {
		if (!host.injected().has(at) && squash(msgs[at]).includes(q)) return at;
	}
	return undefined;
}

// Asked when the model ends or permanently loosens a rule (heed_lift, a session allow): does the user's newer message
// take it back? 12 lift / keep pairs (E18): prose 7/12, this 9/12 at 0.75/0.6, no false lift in any variant; keeps
// scored ≤ 0.07. The misses ("push 吧", "改吧") read as one-time permissions, which heed_record allow once covers.
// Examples are not from that set.
export const LIFT_QUESTION: ChoiceQuestion = {
	type: "choice",
	instructions: {
		question: "Does `user_message` take back `rule`?",
		focus: "Whether the user now permits, from here on, what `rule` forbids. A permission for one time, a question, or a message about something else keeps the rule.",
	},
	criteria: {
		takes_back: { what: "The user now permits what the rule forbids", examples: ["Migrations are fine to touch now.", "数据库可以随便动了"] },
		keeps: { what: "The rule still stands", examples: ["Just this once you may rename the table.", "迁移脚本你准备怎么写？", "先别碰数据库"] },
		unclear: "Cannot tell",
	},
} as unknown as ChoiceQuestion;
export const LIFT_THRESHOLD = { p: 0.75, confidence: 0.6 };

/** Jev's reading of whether `message` takes back `p`. */
async function takesBack(host: LedgerHost, p: Policy, message: string, signal?: AbortSignal): Promise<{ ok: boolean; p: number; error?: string }> {
	if (!host.judge) return { ok: false, p: 0, error: "no judge configured" };
	const state = { rule: describe(p), rule_said: truncate(p.sourceQuote, 300), user_message: truncate(message, 3000) };
	const { answers, error } = await ask(host.judge, state, { q: LIFT_QUESTION }, host.timeoutMs, signal);
	const a = answers?.q as ChoiceAnswer | undefined;
	const pr = a?.probabilities.takes_back ?? 0;
	return { ok: !!a && a.choice === "takes_back" && pr >= LIFT_THRESHOLD.p && a.confidence >= LIFT_THRESHOLD.confidence, p: pr, error: a ? undefined : (error ?? "no answer") };
}

const result = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });

const recordParams = () =>
	Type.Object({
		quote: Type.String({ description: "The user's exact words that set this rule, copied verbatim from one of their messages." }),
		effect: Type.Union([Type.Literal("deny"), Type.Literal("confirm"), Type.Literal("allow")], {
			description: "deny: must not · confirm: only after asking the user · allow: a permission (usually temporary) against an existing rule",
		}),
		action: Type.Union([Type.Literal("modify"), Type.Literal("install_deps"), Type.Literal("git_commit"), Type.Literal("git_push"), Type.Literal("custom")], {
			description: "modify: change or delete files · install_deps: add packages · git_commit / git_push · custom: anything else, described in `text`",
		}),
		target: Type.Optional(
			Type.String({ description: 'For modify: "*" (any file), "tests", a path or directory ("src/api", "package.json"), or a glob ("*.md"). Default "*".' }),
		),
		text: Type.Optional(Type.String({ description: 'For custom: what is forbidden, in plain words ("calling the production API").' })),
		scope: Type.Union([Type.Literal("session"), Type.Literal("run"), Type.Literal("once")], {
			description: "session: until lifted · run: until this request is done · once: a single use (allow only)",
		}),
		unless: Type.Optional(Type.String({ description: 'An exception the user stated for a deny/confirm ("it only fixes a typo"). Judged on each call.' })),
	});

const liftParams = () =>
	Type.Object({
		id: Type.String({ description: "The rule id, e.g. p3 (from the block message or the rules in your instructions)." }),
		quote: Type.String({ description: "The user's exact words, from a message newer than the rule, that lift it." }),
	});

export function registerLedgerTools(pi: ExtensionAPI, host: LedgerHost) {
	pi.registerTool({
		name: "heed_record",
		label: "Record a user rule",
		description:
			"Record a rule the user stated about what you may or may not do, so pi-heed enforces it on your tool calls for the rest of the session, " +
			"also after context compaction. The quote must be the user's exact words.",
		promptSnippet: "heed_record: record a rule the user set (e.g. don't touch tests, no push), quoting their words",
		promptGuidelines: [
			"When the user states a rule about what you may not do (files or directories not to change, no new dependencies, no commit or push, read-only, or anything else like 'don't call the production API'), record it with heed_record, quoting their exact words.",
			"Do not turn conversational pacing ('let's discuss first', '先看看') into a rule. A hold that names what to protect is a rule ('测试文件先别动' → deny modify tests).",
			"For a temporary or partial permission ('this once you may edit package.json'), record effect allow with scope once or run. Do not lift the original rule.",
			"If pi-heed blocks a call and the user has since lifted that rule, call heed_lift with the rule id and their exact words. Otherwise ask the user.",
		],
		parameters: recordParams(),
		async execute(_id, params, signal) {
			const at = findQuote(host, params.quote);
			if (at === undefined) {
				return result("Not recorded: the quote is not in any message the user typed. Copy their exact words (a short verbatim span is enough).", { ok: false });
			}
			if (params.scope === "once" && params.effect !== "allow") {
				return result('Not recorded: scope "once" is only for an allow (a single-use permission). Use "session" or "run" for a restriction.', { ok: false });
			}
			if (params.unless && params.effect === "allow") return result('Not recorded: "unless" belongs on a deny or confirm.', { ok: false });
			const custom = params.action === "custom";
			const resource = custom ? squash(params.text ?? "") : params.action === "modify" ? squash(params.target ?? "*") || "*" : "*";
			if (custom && !resource) return result('Not recorded: a custom rule needs "text".', { ok: false });
			const spec: PolicySpec = {
				effect: params.effect === "deny" ? "DENY" : params.effect === "confirm" ? "REQUIRE_CONFIRMATION" : "ALLOW",
				action: params.action,
				resource,
				scope: params.scope,
				sourceQuote: truncate(squash(params.quote), 300),
				by: "model",
				at,
				...(params.unless ? { unless: squash(params.unless) } : {}),
			};
			// A lasting permission against a rule loosens it for good: the same check as heed_lift, or it would be a way
			// around it. A once / run permission is bounded and needs only the receipt.
			if (spec.effect === "ALLOW" && spec.scope === "session") {
				for (const q of host.affectedBy(spec)) {
					if (q.provenance.at > at) continue; // the rule is newer than the permission's words
					// a carve-out ("src/api 可以改" under "src 不能改") takes back only the carved part: ask about that part
					const part = q.resource === spec.resource && q.action === spec.action ? q : { ...q, action: spec.action, resource: spec.resource };
					const t = await takesBack(host, part, host.messages()[at], signal);
					if (!t.ok) {
						const why = t.error ? `it could not be checked (${t.error})` : `the user's message does not clearly lift rule ${q.id} (p=${t.p.toFixed(2)})`;
						return result(`Not recorded: ${why}. If the user allowed it only for now, record scope once or run. Otherwise ask the user.`, { ok: false });
					}
				}
			}
			const lines = host.commit([{ op: "add", spec }]);
			return result(lines.length ? `Recorded. ${lines.join("; ")}` : "Already recorded; nothing changed.", { ok: true, lines });
		},
	});

	pi.registerTool({
		name: "heed_lift",
		label: "Lift a user rule",
		description:
			"End a rule recorded earlier, because the user lifted it in a later message. Give the rule id and the user's exact words. " +
			"For a one-off permission, use heed_record with effect allow instead.",
		promptSnippet: "heed_lift: end a rule the user has lifted, quoting their words",
		parameters: liftParams(),
		async execute(_id, params, signal) {
			const p = host.policy(params.id);
			if (!p || p.status !== "active") return result(`Nothing lifted: there is no active rule ${params.id}.`, { ok: false });
			const at = findQuote(host, params.quote, p.provenance.at);
			if (at === undefined) {
				return result(`Nothing lifted: the quote is not in a message the user typed after rule ${p.id} was set. Ask the user.`, { ok: false });
			}
			if (!host.judge) return result(`Nothing lifted: no judge is configured to check it. Ask the user to run /heed drop ${p.id}.`, { ok: false });
			const t = await takesBack(host, p, host.messages()[at], signal);
			if (!t.ok) {
				const why = t.error ? `it could not be checked (${t.error})` : `the user's message does not clearly take it back (p=${t.p.toFixed(2)})`;
				return result(`Not lifted: ${why}. Rule ${p.id} still applies. If the user allowed it only for now, heed_record an allow with scope once or run; otherwise ask the user.`, { ok: false, p: t.p });
			}
			const lines = host.commit([{ op: "supersede", id: p.id, reason: `lifted (model, jev p=${t.p.toFixed(2)}): "${truncate(squash(params.quote), 120)}"`, by: "model" }]);
			return result(`Lifted. ${lines.join("; ")}`, { ok: true, p: t.p });
		},
	});
}
