import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, truncate } from "./actions.ts";
import { ConstraintLedger } from "./constraints.ts";
import { judgeCheck, ruleCheck } from "./gate.ts";
import { JevJudge, type Judge, resolveTransport } from "./judge.ts";
import { RepeatTracker } from "./repeat.ts";
import { DEFAULT_CONFIG, type HeedConfig, type Mode, type ToolAction, type Verdict } from "./types.ts";

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
	note?: string;
	ms?: number;
	error?: string;
	stale?: boolean;
	budgetExhausted?: boolean;
	constraints?: string[];
}

const MODES: Mode[] = ["off", "shadow", "enforce"];

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
	const pending = new Map<string, ToolAction>();
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

	function rebuild(ctx: ExtensionContext) {
		ledger.reset();
		repeat.reset();
		pending.clear();
		for (const entry of ctx.sessionManager.getBranch() as Array<Record<string, any>>) {
			if (entry.type === "message" && entry.message?.role === "user") {
				const text = textOf(entry.message.content);
				if (!text.startsWith("/")) ledger.ingest(text);
			} else if (entry.type === "custom" && entry.customType === "heed-constraint") {
				if (entry.data?.op === "add") ledger.add("custom", String(entry.data.text), "command");
				if (entry.data?.op === "drop") ledger.drop(String(entry.data.id));
			} else if (entry.type === "custom" && entry.customType === "heed-config" && MODES.includes(entry.data?.mode)) {
				config.mode = entry.data.mode;
			}
		}
		status(ctx);
	}

	pi.on("session_start", (_e, ctx) => rebuild(ctx));
	pi.on("session_tree", (_e, ctx) => rebuild(ctx));

	pi.on("input", (event, ctx) => {
		// Only the human's words define constraints; our own and other extensions' injections do not.
		if (config.mode === "off" || event.source === "extension" || event.text.startsWith("/")) return;
		const { added, revoked } = ledger.ingest(event.text);
		if (added.length || revoked.length) {
			log({
				kind: "constraint",
				acted: false,
				constraints: [...added.map((c) => `+${c.id} ${c.kind}: ${truncate(c.quote, 120)}`), ...revoked.map((c) => `-${c.id} ${c.kind}`)],
			});
			status(ctx);
		}
	});

	pi.on("agent_start", () => {
		run++;
		interventions = 0;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (config.mode === "off") return;
		const input = event.input as Record<string, unknown>;
		const action = classify(event.toolName, input);
		pending.set(event.toolCallId, action);
		const active = ledger.active();
		if (active.length === 0) return;

		const myRun = run;
		let verdict = ruleCheck(active, action);
		let ms: number | undefined;
		let error: string | undefined;
		if (!verdict) {
			const judged = await judgeCheck(judge, active, action, input, config.judgeTimeoutMs, ctx.signal);
			({ verdict, ms, error } = judged);
			// A result for a run that is over (Esc, new prompt) must not act on the new one.
			if (myRun !== run || ctx.signal?.aborted) {
				log({ kind: "gate", acted: false, tool: action.toolName, summary: action.summary, verdict, ms, error, stale: true });
				return;
			}
		}
		// Keep failed judge calls in the log (they are data), but not "no judge configured".
		if (!verdict && (!error || !judge)) return;

		const blockable =
			verdict?.decision === "violates" &&
			(verdict.by === "rule" || (verdict.probability >= config.blockProbability && verdict.confidence >= config.blockConfidence));
		const act = blockable && canIntervene();
		log({
			kind: "gate",
			acted: act,
			tool: action.toolName,
			summary: action.summary,
			verdict,
			ms,
			error,
			budgetExhausted: blockable && config.mode === "enforce" && !act,
		});
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
						...ledger.active().map((c) => `  ${c.id} [${c.kind}] ${truncate(c.quote, 100)}`),
					];
					return say(lines.join("\n"));
				}
				case "mode":
					if (!MODES.includes(arg as Mode)) return say(`usage: /heed mode <${MODES.join("|")}>`, "warning");
					config.mode = arg as Mode;
					pi.appendEntry("heed-config", { mode: config.mode });
					status(ctx);
					return say(`pi-heed mode: ${config.mode}`);
				case "constraints": {
					const active = ledger.active();
					return say(active.length ? active.map((c) => `${c.id} [${c.kind}] ${c.quote}`).join("\n") : "no active constraints");
				}
				case "add": {
					if (!arg) return say("usage: /heed add <constraint text>", "warning");
					const c = ledger.add("custom", arg, "command");
					if (c) pi.appendEntry("heed-constraint", { op: "add", text: arg });
					status(ctx);
					return say(c ? `added ${c.id}` : "already active");
				}
				case "drop":
					if (!ledger.drop(arg)) return say(`no active constraint ${arg}`, "warning");
					pi.appendEntry("heed-constraint", { op: "drop", id: arg });
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
							return `${e.id} ${r.kind}${r.acted ? " ACTED" : ""}${v}${r.stale ? " stale" : ""}${r.error ? ` err=${r.error}` : ""} ${r.summary ?? r.constraints?.join(", ") ?? ""}`;
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

	return { config, ledger, repeat, get run() { return run; }, get interventions() { return interventions; } };
}

export default function (pi: ExtensionAPI) {
	createHeed(pi);
}
