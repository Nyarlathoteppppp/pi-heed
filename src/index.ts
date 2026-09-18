import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, truncate } from "./actions.ts";
import { exceptionCheck, judgeCheck, policyVerdict } from "./gate.ts";
import { JevJudge, type Judge, resolveTransport, settle } from "./judge.ts";
import { describe, type Policy, PolicyEngine, type PolicyOp, type Prerequisite, type Resolution } from "./policy.ts";
import { RepeatTracker } from "./repeat.ts";
import { mentionedPaths, parseMessage } from "./rules.ts";
import { DEFAULT_CONFIG, type HeedConfig, type Mode, type ToolAction, type Verdict } from "./types.ts";
import { understand } from "./understand.ts";

export interface HeedOptions {
	/** Override the judge (tests). `null` disables semantic checks. */
	judge?: Judge | null;
	config?: Partial<HeedConfig>;
	env?: NodeJS.ProcessEnv;
}

export interface HeedLogRecord {
	kind: "gate" | "repeat" | "constraint";
	mode: Mode;
	/** True when pi-heed actually changed what happened (block / note). */
	acted: boolean;
	run: number;
	tool?: string;
	summary?: string;
	/** Policy that decided the call. */
	policy?: string;
	verdict?: Verdict;
	/** A rule block that Jev found the user had explicitly excepted. */
	exception?: { choice: string; p: number; confidence: number };
	note?: string;
	ms?: number;
	/** Gate decision was computed while the model was still streaming the call. */
	prejudged?: boolean;
	/** Time the tool call actually waited on pi-heed. */
	waitedMs?: number;
	error?: string;
	stale?: boolean;
	budgetExhausted?: boolean;
	constraints?: string[];
	/** Jev's policy deltas for one message (kind / p / confidence / applied). */
	deltas?: Record<string, unknown>;
}

/** Persisted policy ops. `rules` entries mark a user message as parsed, so a rebuild never re-parses it. */
export interface PolicyEntry {
	kind: "rules" | "jev" | "use" | "end" | "command";
	at: number;
	ops: PolicyOp[];
	source?: "extension";
}

interface Decision {
	verdict?: Verdict;
	policyId?: string;
	exception?: HeedLogRecord["exception"];
	error?: string;
	ms: number;
}

const MODES: Mode[] = ["off", "shadow", "enforce"];
const MEMO_LIMIT = 200;
/** Tools whose path argument streams before a (possibly long) body. */
const PATH_FIRST_TOOLS = new Set(["edit", "write"]);

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("\n");
}

/** Legacy (v0.2/v0.3) constraint kinds → policy ops, for sessions recorded before the policy engine. */
const LEGACY_KIND: Record<string, { action: "modify" | "install_deps"; resource: string }> = {
	read_only: { action: "modify", resource: "*" },
	no_tests: { action: "modify", resource: "tests" },
	no_deps: { action: "install_deps", resource: "*" },
};

export function createHeed(pi: ExtensionAPI, options: HeedOptions = {}) {
	const env = options.env ?? process.env;
	const envMode = env.PI_HEED_MODE as Mode | undefined;
	const config: HeedConfig = { ...DEFAULT_CONFIG, ...(envMode && MODES.includes(envMode) ? { mode: envMode } : {}), ...options.config };
	const transport = options.judge === undefined ? resolveTransport(env) : undefined;
	const judge: Judge | undefined = options.judge === undefined ? (transport ? new JevJudge(transport) : undefined) : (options.judge ?? undefined);

	const engine = new PolicyEngine();
	const repeat = new RepeatTracker(config.repeatThreshold);
	const userMessages: string[] = [];
	const pending = new Map<string, ToolAction>();
	const speculative = new Map<string, { inputKey: string; decision: Promise<Decision | undefined>; early: boolean; path?: string }>();
	const memo = new Map<string, Promise<Decision>>();
	let understanding: Promise<void> | undefined;
	let run = 0;
	let interventions = 0;
	/** Change-epoch at which the tests last passed; REQUIRE_BEFORE("tests") holds while nothing changed since. */
	let testsOkEpoch = -1;

	const log = (r: Omit<HeedLogRecord, "mode" | "run">) => pi.appendEntry<HeedLogRecord>("heed", { ...r, mode: config.mode, run });

	const status = (ctx: ExtensionContext, extra?: string) => {
		if (!ctx.hasUI) return;
		if (config.mode === "off") return ctx.ui.setStatus("heed", undefined);
		const n = engine.active().length;
		ctx.ui.setStatus("heed", `heed:${config.mode}${n ? ` ${n}p` : ""}${extra ? ` · ${extra}` : ""}`);
	};

	const canIntervene = () => config.mode === "enforce" && interventions < config.maxInterventionsPerRun;
	const satisfied = (p: Prerequisite) => p === "tests" && testsOkEpoch === repeat.epoch;

	function applyOps(ops: PolicyOp[]): string[] {
		const lines = ops.flatMap((op) => engine.apply(op));
		if (lines.length) memo.clear();
		return lines;
	}

	/** Applies ops and persists them so a rebuild replays exactly this. */
	function commit(entry: PolicyEntry): string[] {
		const lines = applyOps(entry.ops);
		if (entry.ops.length || entry.kind === "rules") pi.appendEntry<PolicyEntry>("heed-policy", entry);
		return lines;
	}

	function rebuild(ctx: ExtensionContext) {
		engine.reset();
		repeat.reset();
		pending.clear();
		speculative.clear();
		memo.clear();
		userMessages.length = 0;
		understanding = undefined;
		testsOkEpoch = -1;
		const branch = ctx.sessionManager.getBranch() as Array<Record<string, any>>;
		const parsed = new Set(branch.filter((e) => e.type === "custom" && e.customType === "heed-policy" && e.data?.kind === "rules").map((e) => e.data.at as number));
		for (const entry of branch) {
			if (entry.type === "message" && entry.message?.role === "user") {
				const text = textOf(entry.message.content);
				if (text.startsWith("/")) continue;
				const at = userMessages.length;
				userMessages.push(text);
				// Sessions from before the policy engine: parse now.
				if (!parsed.has(at)) applyOps(parseMessage(text, at));
			} else if (entry.type === "custom" && entry.customType === "heed-policy") {
				applyOps((entry.data as PolicyEntry).ops ?? []);
			} else if (entry.type === "custom" && entry.customType === "heed-constraint") {
				applyOps(legacyOps(entry.data ?? {}, userMessages.length));
			} else if (entry.type === "custom" && entry.customType === "heed-config" && MODES.includes(entry.data?.mode)) {
				config.mode = entry.data.mode;
			}
		}
		status(ctx);
	}

	function legacyOps(d: Record<string, any>, at: number): PolicyOp[] {
		const add = (action: "modify" | "install_deps" | "custom", resource: string, quote: string, by: "jev" | "command"): PolicyOp => ({
			op: "add",
			spec: { effect: "DENY", action, resource, scope: "session", sourceQuote: quote, by, at },
		});
		if (d.op === "add") return [add("custom", String(d.text), String(d.text), "command")];
		if (d.op === "jev") {
			const quote = String(d.quote ?? "");
			return [
				...((d.lift ?? []) as string[]).filter((k) => LEGACY_KIND[k]).map((k): PolicyOp => ({
					op: "add",
					spec: { effect: "ALLOW", ...LEGACY_KIND[k], scope: "session", sourceQuote: quote, by: "jev", at },
				})),
				...((d.add ?? []) as string[]).filter((k) => LEGACY_KIND[k]).map((k) => add(LEGACY_KIND[k].action, LEGACY_KIND[k].resource, quote, "jev")),
			];
		}
		return []; // legacy drop/reject referenced ledger ids that no longer exist
	}

	/** Restrictive policy decided the call: ask Jev only whether the user carved out an exception for it. */
	async function restrictiveDecision(r: Resolution, action: ToolAction, signal?: AbortSignal): Promise<Decision> {
		const p = r.policy!;
		const verdict = policyVerdict(r, action)!;
		// Satisfiable by doing the prerequisite; no exception to look for.
		if (p.effect === "REQUIRE_BEFORE") return { verdict, policyId: p.id, ms: 0 };
		// Only messages the rules did NOT already turn into a permission: a permission they did parse has
		// its own lifecycle (a used once-permission must not be revived by re-reading its message).
		const understood = new Set(engine.all().filter((q) => q.effect === "ALLOW").map((q) => q.provenance.at));
		const since = userMessages
			.map((text, at) => ({ text, at }))
			.filter(({ text, at }) => at >= p.provenance.at && !understood.has(at) && !(at === p.provenance.at && text.trim() === p.sourceQuote.trim()))
			.map(({ text }) => text);
		const x = await exceptionCheck(judge, p, since, action, config.judgeTimeoutMs, signal);
		const exception = x.answer ? { choice: x.answer.choice, p: x.answer.probabilities[x.answer.choice] ?? 0, confidence: x.answer.confidence } : undefined;
		if (x.permitted) return { exception, policyId: p.id, ms: x.ms };
		return { verdict, policyId: p.id, exception, error: x.error === "no judge configured" ? undefined : x.error, ms: x.ms };
	}

	/** Full gate decision: resolved policy state first, then Jev for free-text prohibitions. */
	async function decide(action: ToolAction, input: Record<string, unknown>, signal?: AbortSignal): Promise<Decision> {
		const r = engine.resolve(action, satisfied);
		if (r.policy) return restrictiveDecision(r, action, signal);
		const custom = engine.customDenies();
		if (custom.length === 0) return { ms: 0 };
		const key = JSON.stringify([custom.map((c) => c.id), action.toolName, input]);
		let hit = memo.get(key);
		if (!hit) {
			hit = judgeCheck(judge, custom, action, input, config.judgeTimeoutMs, signal).then((j) => {
				if (!j.verdict) memo.delete(key); // never cache failures
				return j;
			});
			memo.set(key, hit);
			if (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value!);
		}
		return hit;
	}

	/** Once-permissions that let a call through are used up. */
	function consume(allowIds: string[]) {
		const ops = allowIds.filter((id) => engine.get(id)?.scope === "once").map((id): PolicyOp => ({ op: "use", id }));
		if (!ops.length) return;
		const lines = commit({ kind: "use", at: userMessages.length - 1, ops });
		if (lines.length) log({ kind: "constraint", acted: false, constraints: lines });
	}

	/** Logs a finished decision and says whether to block. Shared by the blocking and the background (shadow) path. */
	function conclude(
		d: Decision,
		action: ToolAction,
		ctx: ExtensionContext,
		extra: { prejudged: boolean; waitedMs: number; stale: boolean },
	): { block: true; reason: string } | undefined {
		const { verdict, exception, error, ms, policyId } = d;
		if (!verdict && !exception && !error) return;
		const base = { kind: "gate" as const, tool: action.toolName, summary: action.summary, policy: policyId, verdict, exception, ms, error, prejudged: extra.prejudged, waitedMs: extra.waitedMs };
		// A result for a run that is over (Esc, new prompt) must not act on the new one.
		if (extra.stale) {
			log({ ...base, acted: false, stale: true });
			return;
		}
		const blockable =
			verdict?.decision === "violates" &&
			(verdict.by === "rule" || (verdict.probability >= config.blockProbability && verdict.confidence >= config.blockConfidence));
		const act = blockable && canIntervene();
		log({ ...base, acted: act, budgetExhausted: blockable && config.mode === "enforce" && !act });
		if (!blockable) return;
		if (!act) {
			status(ctx, config.mode === "shadow" ? `would block ${action.toolName}` : "budget spent");
			return;
		}
		interventions++;
		status(ctx, `blocked ${action.toolName}`);
		return { block: true, reason: `[pi-heed] ${verdict!.evidence}` };
	}

	pi.on("session_start", (_e, ctx) => {
		rebuild(ctx);
		// Pay DNS + TLS now rather than on the first real decision (measured: 746 ms cold vs ~270 ms warm).
		if (config.mode !== "off") judge?.warm?.();
	});
	pi.on("session_tree", (_e, ctx) => rebuild(ctx));

	pi.on("input", (event, ctx) => {
		if (event.text.startsWith("/")) return;
		const at = userMessages.length;
		userMessages.push(event.text);
		// Only the human's words define policy; our own and other extensions' injections do not.
		// Still recorded (empty) so a rebuild knows this message was seen and never parses it.
		if (event.source === "extension") {
			commit({ kind: "rules", at, ops: [], source: "extension" });
			return;
		}
		// Parsed in every mode (local, deterministic) so switching modes never loses what was said.
		const before = engine.active();
		const seqBefore = engine.all().length;
		const lines = commit({ kind: "rules", at, ops: parseMessage(event.text, at) });
		if (config.mode === "off") return;
		if (lines.length) log({ kind: "constraint", acted: false, constraints: lines });
		status(ctx);
		if (!judge) return;
		const text = event.text;
		const input = {
			message: text,
			at,
			before,
			touchedByRules: new Set(before.filter((p) => p.status !== "active").map((p) => p.id)),
			createdByRules: engine.all().slice(seqBefore).filter((p) => p.status === "active"),
			hasGoalScoped: before.some((p) => p.scope === "goal"),
			mentionedPaths: mentionedPaths(text),
		};
		// Policy deltas in the background; the gate awaits this only if a tool call beats it.
		understanding = understand(judge, input, config.judgeTimeoutMs).then((u) => {
			const jevLines = u.ops.length ? commit({ kind: "jev", at, ops: u.ops }) : [];
			if (jevLines.length || Object.keys(u.deltas).length || u.error) {
				log({ kind: "constraint", acted: false, constraints: jevLines, deltas: u.deltas, ms: u.ms, error: u.error });
			}
			if (jevLines.length) status(ctx);
		});
	});

	pi.on("agent_start", () => {
		run++;
		interventions = 0;
	});

	pi.on("agent_end", (_e, ctx) => {
		pending.clear();
		speculative.clear();
		const lines = commit({ kind: "end", at: userMessages.length - 1, ops: engine.active().some((p) => p.scope === "run") ? [{ op: "end", scope: "run" }] : [] });
		if (lines.length && config.mode !== "off") {
			log({ kind: "constraint", acted: false, constraints: lines });
			status(ctx);
		}
	});

	// Speculative pre-judging. Jev costs ~250 ms per call no matter how much it is asked, so the only lever is
	// *when* the call starts. pi parses tool arguments while they stream:
	//  - edit/write: the policy verdict needs only the tool name and path, which stream first; the file content
	//    that follows often takes seconds, so the exception check starts as soon as the path is complete.
	//  - everything else: arguments are final at toolcall_end, still before tool_call fires.
	pi.on("message_update", (event, ctx) => {
		const e = event.assistantMessageEvent;
		if (config.mode === "off") return;
		if (e.type === "toolcall_delta") {
			const tc = e.partial.content[e.contentIndex];
			if (tc?.type !== "toolCall" || !PATH_FIRST_TOOLS.has(tc.name) || speculative.has(tc.id)) return;
			const args = (tc.arguments ?? {}) as Record<string, unknown>;
			// A streamed string is only final once the model has moved on to the next key.
			if (typeof args.path !== "string" || !Object.keys(args).some((k) => k !== "path")) return;
			const action = classify(tc.name, { path: args.path });
			const early = settle(understanding, config.judgeTimeoutMs).then(() => {
				const r = engine.resolve(action, satisfied);
				return r.policy ? restrictiveDecision(r, action, ctx.signal) : undefined;
			});
			early.catch(() => {});
			speculative.set(tc.id, { inputKey: "", decision: early, early: true, path: args.path });
			return;
		}
		if (e.type !== "toolcall_end") return;
		const { id, name, arguments: args } = e.toolCall;
		const action = classify(name, args);
		if (!action.mutates && action.effect !== "unknown") return;
		const prior = speculative.get(id);
		const reuse = prior?.early && prior.path === args.path;
		const decision = reuse
			? prior!.decision.then((d) => d ?? decide(action, args, ctx.signal))
			: settle(understanding, config.judgeTimeoutMs).then(() => decide(action, args, ctx.signal));
		decision.catch(() => {});
		speculative.set(id, { inputKey: JSON.stringify(args), decision, early: false });
	});

	pi.on("tool_call", async (event, ctx) => {
		if (config.mode === "off") return;
		const input = event.input as Record<string, unknown>;
		const action = classify(event.toolName, input);
		pending.set(event.toolCallId, action);
		if (!action.mutates && action.effect !== "unknown") return;

		const started = Date.now();
		const myRun = run;
		const spec = speculative.get(event.toolCallId);
		speculative.delete(event.toolCallId);
		// Another extension may have patched the input since it streamed; then the pre-judgement is void.
		const prejudged = !!spec && !spec.early && spec.inputKey === JSON.stringify(input);

		const pendingDecision = (async (): Promise<{ d: Decision; allowIds: string[] } | undefined> => {
			let d = prejudged ? await settle(spec!.decision, config.judgeTimeoutMs) : undefined;
			if (!prejudged) await settle(understanding, config.judgeTimeoutMs);
			// Policy state may have moved since the pre-judgement (a once-permission used by an earlier call):
			// resolution is µs, so always recheck it and only reuse Jev's work for the same deciding policy.
			const fresh = engine.resolve(action, satisfied);
			if (d && d.policyId !== fresh.policy?.id) d = undefined;
			d ??= await decide(action, input, ctx.signal);
			return { d, allowIds: fresh.allowIds };
		})().catch(() => undefined);

		// Shadow mode never blocks, so it never makes the tool wait: decide and log in the background.
		if (config.mode === "shadow") {
			pendingDecision.then((res) => {
				if (!res) return;
				conclude(res.d, action, ctx, { prejudged, waitedMs: 0, stale: myRun !== run });
				consume(res.allowIds);
			});
			return;
		}
		const res = await pendingDecision;
		if (!res) return;
		const block = conclude(res.d, action, ctx, { prejudged, waitedMs: Date.now() - started, stale: myRun !== run || !!ctx.signal?.aborted });
		if (!block) consume(res.allowIds);
		return block;
	});

	pi.on("tool_result", (event, ctx) => {
		if (config.mode === "off") return;
		const action = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (!event.isError) {
			if (action?.mutates) repeat.markChange();
			if (action?.runsTests) testsOkEpoch = repeat.epoch;
			return;
		}
		if (event.toolName !== "bash") return;
		const evidence = repeat.recordFailure(String((event.input as Record<string, unknown>).command ?? ""), textOf(event.content));
		if (!evidence) return;
		const act = canIntervene();
		log({ kind: "repeat", acted: act, tool: "bash", summary: truncate(evidence.command, 200), note: evidence.note });
		if (!act) {
			status(ctx, config.mode === "shadow" ? "would note repeat" : "budget spent");
			return;
		}
		interventions++;
		status(ctx, "repeat noted");
		// Appended to the failing result itself: no extra turn, earlier context untouched.
		return { content: [...event.content, { type: "text" as const, text: evidence.note }] };
	});

	const line = (p: Policy) =>
		`${p.id} ${describe(p)}${p.exceptions.length ? ` except ${p.exceptions.join(",")}` : ""}  ← ${p.provenance.by} #${p.provenance.at}: "${truncate(p.sourceQuote, 80)}"`;

	pi.registerCommand("heed", {
		description:
			"pi-heed: status | policies | history | explain <id> | mode <off|shadow|enforce> | add <text> | drop <id> | log [n] | label <good|bad> [note]",
		getArgumentCompletions: (prefix) => {
			const subs = ["status", "policies", "history", "explain", "mode", "add", "drop", "log", "label"];
			return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");
			const say = (msg: string, level: "info" | "warning" = "info") => ctx.ui.notify(msg, level);
			switch (sub) {
				case "status":
					return say(
						[
							`mode: ${config.mode}   judge: ${judge?.name ?? "none (rules only)"}   interventions this run: ${interventions}/${config.maxInterventionsPerRun}`,
							...engine.active().map((p) => `  ${line(p)}`),
						].join("\n"),
					);
				case "policies":
				case "constraints": {
					const active = engine.active();
					return say(active.length ? active.map(line).join("\n") : "no active policies");
				}
				case "history": {
					const h = engine.history();
					return say(h.length ? h.map((p) => `${line(p)}  [${p.status}: ${p.provenance.endReason ?? ""}]`).join("\n") : "no superseded or expired policies");
				}
				case "explain": {
					const p = engine.get(arg);
					if (!p) return say(`usage: /heed explain <policy id>  (see /heed policies)`, "warning");
					return say(
						[
							`${p.id}: ${describe(p)}  [${p.status}]`,
							`from user message #${p.provenance.at} (${p.provenance.by}): "${p.sourceQuote}"`,
							p.exceptions.length ? `exceptions: ${p.exceptions.map((id) => `${id} ${engine.get(id) ? describe(engine.get(id)!) : ""}`).join("; ")}` : "",
							p.provenance.endReason ? `ended: ${p.provenance.endReason}` : "",
						]
							.filter(Boolean)
							.join("\n"),
					);
				}
				case "mode":
					if (!MODES.includes(arg as Mode)) return say(`usage: /heed mode <${MODES.join("|")}>`, "warning");
					config.mode = arg as Mode;
					pi.appendEntry("heed-config", { mode: arg });
					status(ctx);
					return say(`pi-heed mode: ${config.mode}`);
				case "add": {
					if (!arg) return say("usage: /heed add <prohibition text>", "warning");
					const lines = commit({
						kind: "command",
						at: userMessages.length,
						ops: [{ op: "add", spec: { effect: "DENY", action: "custom", resource: arg, scope: "session", sourceQuote: arg, by: "command", at: userMessages.length } }],
					});
					status(ctx);
					return say(lines.length ? lines.join("\n") : "already active");
				}
				case "drop": {
					const lines = commit({ kind: "command", at: userMessages.length, ops: [{ op: "supersede", id: arg, reason: "dropped by /heed drop", by: "command" }] });
					status(ctx);
					return say(lines.length ? lines.join("\n") : `no active policy ${arg}`, lines.length ? "info" : "warning");
				}
				case "log": {
					const n = Math.max(1, Number(arg) || 10);
					const records = (ctx.sessionManager.getBranch() as Array<Record<string, any>>)
						.filter((e) => e.type === "custom" && e.customType === "heed")
						.slice(-n)
						.map((e) => {
							const r = e.data as HeedLogRecord;
							const v = r.verdict ? ` ${r.verdict.decision}/${r.verdict.by}` : "";
							const x = r.exception ? ` exception=${r.exception.choice}` : "";
							const w = r.waitedMs !== undefined ? ` waited=${r.waitedMs}ms${r.prejudged ? "(pre)" : ""}` : "";
							return `${e.id} ${r.kind}${r.acted ? " ACTED" : ""}${r.policy ? ` ${r.policy}` : ""}${v}${x}${w}${r.stale ? " stale" : ""}${r.error ? ` err=${r.error}` : ""} ${r.summary ?? r.constraints?.join(", ") ?? ""}`;
						});
					return say(records.length ? records.join("\n") : "no pi-heed records on this branch");
				}
				case "label": {
					const [verdict, ...note] = rest;
					if (verdict !== "good" && verdict !== "bad") return say("usage: /heed label <good|bad> [note]  (labels the latest decision)", "warning");
					const last = (ctx.sessionManager.getBranch() as Array<Record<string, any>>).filter((e) => e.type === "custom" && e.customType === "heed" && e.data?.kind !== "constraint").at(-1);
					if (!last) return say("nothing to label", "warning");
					pi.appendEntry("heed-label", { target: last.id, label: verdict, note: note.join(" ") || undefined });
					return say(`labelled ${last.id} ${verdict}`);
				}
				default:
					return say(`unknown subcommand ${sub}`, "warning");
			}
		},
	});

	return {
		config,
		engine,
		repeat,
		/** Resolves when the latest background understanding pass is applied (tests, benchmark). */
		settled: () => understanding ?? Promise.resolve(),
		get run() {
			return run;
		},
		get interventions() {
			return interventions;
		},
	};
}

export default function (pi: ExtensionAPI) {
	createHeed(pi);
}
