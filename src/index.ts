import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, truncate } from "./actions.ts";
import { ConstraintLedger } from "./constraints.ts";
import { exceptionCheck, judgeCheck, ruleCheck } from "./gate.ts";
import { JevJudge, type Judge, resolveTransport, settle } from "./judge.ts";
import { RepeatTracker } from "./repeat.ts";
import { DEFAULT_CONFIG, type HeedConfig, type Mode, type ToolAction, type Verdict } from "./types.ts";
import { type Understanding, understand } from "./understand.ts";

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
}

interface Decision {
	verdict?: Verdict;
	exception?: HeedLogRecord["exception"];
	error?: string;
	ms: number;
}

interface JevChange {
	op: "jev";
	at: number;
	quote: string;
	add: Understanding["add"];
	lift: Understanding["lift"];
	reject: string[];
}

const MODES: Mode[] = ["off", "shadow", "enforce"];
const MEMO_LIMIT = 200;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("\n");
}

export function createHeed(pi: ExtensionAPI, options: HeedOptions = {}) {
	const env = options.env ?? process.env;
	const envMode = env.PI_HEED_MODE as Mode | undefined;
	const config: HeedConfig = { ...DEFAULT_CONFIG, ...(envMode && MODES.includes(envMode) ? { mode: envMode } : {}), ...options.config };
	const transport = options.judge === undefined ? resolveTransport(env) : undefined;
	const judge: Judge | undefined = options.judge === undefined ? (transport ? new JevJudge(transport) : undefined) : (options.judge ?? undefined);

	const ledger = new ConstraintLedger();
	const repeat = new RepeatTracker(config.repeatThreshold);
	const userMessages: string[] = [];
	const pending = new Map<string, ToolAction>();
	const speculative = new Map<string, { inputKey: string; decision: Promise<Decision> }>();
	const memo = new Map<string, Promise<Decision>>();
	let understanding: Promise<void> | undefined;
	let run = 0;
	let interventions = 0;

	const log = (r: Omit<HeedLogRecord, "mode" | "run">) => pi.appendEntry<HeedLogRecord>("heed", { ...r, mode: config.mode, run });

	const status = (ctx: ExtensionContext, extra?: string) => {
		if (!ctx.hasUI) return;
		if (config.mode === "off") return ctx.ui.setStatus("heed", undefined);
		const n = ledger.active().length;
		ctx.ui.setStatus("heed", `heed:${config.mode}${n ? ` ${n}c` : ""}${extra ? ` · ${extra}` : ""}`);
	};

	const canIntervene = () => config.mode === "enforce" && interventions < config.maxInterventionsPerRun;

	function applyJev(change: JevChange): string[] {
		const lines: string[] = [];
		for (const id of change.reject) if (ledger.drop(id)) lines.push(`-${id} not a prohibition (jev)`);
		for (const kind of change.lift) for (const c of ledger.lift(kind)) lines.push(`-${c.id} ${kind} lifted (jev)`);
		for (const kind of change.add) {
			const c = ledger.add(kind, change.quote, { origin: "message", at: change.at, by: "jev" });
			if (c) lines.push(`+${c.id} ${kind} (jev): ${truncate(c.quote, 120)}`);
		}
		return lines;
	}

	function rebuild(ctx: ExtensionContext) {
		ledger.reset();
		repeat.reset();
		pending.clear();
		speculative.clear();
		memo.clear();
		userMessages.length = 0;
		understanding = undefined;
		for (const entry of ctx.sessionManager.getBranch() as Array<Record<string, any>>) {
			if (entry.type === "message" && entry.message?.role === "user") {
				const text = textOf(entry.message.content);
				if (text.startsWith("/")) continue;
				ledger.ingest(text, "message", userMessages.length);
				userMessages.push(text);
			} else if (entry.type === "custom" && entry.customType === "heed-constraint") {
				const d = entry.data ?? {};
				if (d.op === "add") ledger.add("custom", String(d.text), { origin: "command", at: userMessages.length });
				if (d.op === "drop") ledger.drop(String(d.id));
				if (d.op === "jev") applyJev(d as JevChange);
			} else if (entry.type === "custom" && entry.customType === "heed-config" && MODES.includes(entry.data?.mode)) {
				config.mode = entry.data.mode;
			}
		}
		status(ctx);
	}

	/** Full gate decision for one call: rules (+ exception second opinion), then Jev for free-text constraints. */
	async function decide(action: ToolAction, input: Record<string, unknown>, signal?: AbortSignal): Promise<Decision> {
		const active = ledger.active();
		if (active.length === 0) return { ms: 0 };
		const rule = ruleCheck(active, action);
		if (rule) {
			const c = ledger.get(rule.constraintId!)!;
			// The constraint's own message counts too ("don't edit files — except notes.txt"), unless it says nothing else.
			const since = userMessages.slice(c.at);
			if (since[0]?.trim() === c.quote.trim()) since.shift();
			const x = await exceptionCheck(judge, c, since, action, config.judgeTimeoutMs, signal);
			const exception = x.answer ? { choice: x.answer.choice, p: x.answer.probabilities[x.answer.choice] ?? 0, confidence: x.answer.confidence } : undefined;
			if (x.permitted) return { exception, ms: x.ms };
			return { verdict: rule, exception, error: x.error === "no judge configured" ? undefined : x.error, ms: x.ms };
		}
		const custom = active.filter((c) => c.kind === "custom");
		if (custom.length === 0) return { ms: 0 };
		const key = JSON.stringify([custom.map((c) => c.id), action.toolName, input]);
		let hit = memo.get(key);
		if (!hit) {
			hit = judgeCheck(judge, active, action, input, config.judgeTimeoutMs, signal).then((r) => {
				if (!r.verdict) memo.delete(key); // never cache failures
				return r;
			});
			memo.set(key, hit);
			if (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value!);
		}
		return hit;
	}

	pi.on("session_start", (_e, ctx) => rebuild(ctx));
	pi.on("session_tree", (_e, ctx) => rebuild(ctx));

	pi.on("input", (event, ctx) => {
		// Only the human's words define constraints; our own and other extensions' injections do not.
		if (config.mode === "off" || event.source === "extension" || event.text.startsWith("/")) return;
		const at = userMessages.length;
		const activeBefore = ledger.active();
		const { added, revoked } = ledger.ingest(event.text, "message", at);
		userMessages.push(event.text);
		if (added.length || revoked.length) {
			log({
				kind: "constraint",
				acted: false,
				constraints: [...added.map((c) => `+${c.id} ${c.kind}: ${truncate(c.quote, 120)}`), ...revoked.map((c) => `-${c.id} ${c.kind}`)],
			});
		}
		status(ctx);
		if (!judge) return;
		// Fan-out understanding in the background; the gate awaits it only if a tool call beats it.
		const stillActive = activeBefore.filter((c) => c.active);
		const newCustom = added.filter((c) => c.kind === "custom");
		const text = event.text;
		understanding = understand(judge, text, stillActive, newCustom, config.judgeTimeoutMs).then((u) => {
			if (u.error || !(u.add.length || u.lift.length || u.reject.length)) return;
			const change: JevChange = { op: "jev", at, quote: truncate(text, 300), add: u.add, lift: u.lift, reject: u.reject };
			const lines = applyJev(change);
			if (!lines.length) return;
			pi.appendEntry("heed-constraint", change);
			log({ kind: "constraint", acted: false, constraints: lines, ms: u.ms });
			memo.clear();
			status(ctx);
		});
	});

	pi.on("agent_start", () => {
		run++;
		interventions = 0;
	});

	pi.on("agent_end", () => {
		pending.clear();
		speculative.clear();
	});

	// Speculative pre-judging: the call's arguments are final at toolcall_end, but tool_call only fires
	// after the whole assistant message has streamed. Start deciding now; don't block the stream.
	pi.on("message_update", (event, ctx) => {
		const e = event.assistantMessageEvent;
		if (config.mode === "off" || e.type !== "toolcall_end") return;
		const { id, name, arguments: args } = e.toolCall;
		const action = classify(name, args);
		if (!action.mutates && action.effect !== "unknown") return;
		const decision = settle(understanding, config.judgeTimeoutMs).then(() => decide(action, args, ctx.signal));
		decision.catch(() => {});
		speculative.set(id, { inputKey: JSON.stringify(args), decision });
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
		const prejudged = spec?.inputKey === JSON.stringify(input);
		let d: Decision | undefined;
		if (prejudged) d = await settle(spec!.decision, config.judgeTimeoutMs);
		if (!d) {
			await settle(understanding, config.judgeTimeoutMs);
			if (ledger.active().length === 0) return;
			d = await decide(action, input, ctx.signal);
		}
		const waitedMs = Date.now() - started;
		const { verdict, exception, error, ms } = d;
		const base = { kind: "gate" as const, tool: action.toolName, summary: action.summary, verdict, exception, ms, error, prejudged, waitedMs };

		// A result for a run that is over (Esc, new prompt) must not act on the new one.
		if (myRun !== run || ctx.signal?.aborted) {
			if (verdict || exception || error) log({ ...base, acted: false, stale: true });
			return;
		}
		if (!verdict && !exception && !error) return;

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
	});

	pi.on("tool_result", (event, ctx) => {
		if (config.mode === "off") return;
		const action = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (!event.isError) {
			if (action?.mutates) repeat.markChange();
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

	pi.registerCommand("heed", {
		description: "pi-heed: status | mode <off|shadow|enforce> | constraints | add <text> | drop <id> | log [n] | label <good|bad> [note]",
		getArgumentCompletions: (prefix) => {
			const subs = ["status", "mode", "constraints", "add", "drop", "log", "label"];
			return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");
			const say = (msg: string, level: "info" | "warning" = "info") => ctx.ui.notify(msg, level);
			switch (sub) {
				case "status": {
					const lines = [
						`mode: ${config.mode}   judge: ${judge?.name ?? "none (rules only)"}   interventions this run: ${interventions}/${config.maxInterventionsPerRun}`,
						...ledger.active().map((c) => `  ${c.id} [${c.kind}${c.by === "jev" ? "·jev" : ""}] ${truncate(c.quote, 100)}`),
					];
					return say(lines.join("\n"));
				}
				case "mode":
					if (!MODES.includes(arg as Mode)) return say(`usage: /heed mode <${MODES.join("|")}>`, "warning");
					pi.appendEntry("heed-config", { mode: arg });
					// Replays the branch, so constraints stated while "off" are picked up too.
					rebuild(ctx);
					return say(`pi-heed mode: ${config.mode}`);
				case "constraints": {
					const active = ledger.active();
					return say(active.length ? active.map((c) => `${c.id} [${c.kind}${c.by === "jev" ? "·jev" : ""}] ${c.quote}`).join("\n") : "no active constraints");
				}
				case "add": {
					if (!arg) return say("usage: /heed add <constraint text>", "warning");
					const c = ledger.add("custom", arg, { origin: "command", at: userMessages.length });
					if (c) pi.appendEntry("heed-constraint", { op: "add", text: arg });
					memo.clear();
					status(ctx);
					return say(c ? `added ${c.id}` : "already active");
				}
				case "drop":
					if (!ledger.drop(arg)) return say(`no active constraint ${arg}`, "warning");
					pi.appendEntry("heed-constraint", { op: "drop", id: arg });
					memo.clear();
					status(ctx);
					return say(`dropped ${arg}`);
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
							return `${e.id} ${r.kind}${r.acted ? " ACTED" : ""}${v}${x}${w}${r.stale ? " stale" : ""}${r.error ? ` err=${r.error}` : ""} ${r.summary ?? r.constraints?.join(", ") ?? ""}`;
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
		ledger,
		repeat,
		/** Resolves when the latest background understanding pass is applied (tests). */
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
