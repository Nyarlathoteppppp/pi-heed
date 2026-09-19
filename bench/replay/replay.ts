// Replays your own pi sessions through pi-heed (enforce, live Jev) without executing anything: what rules would
// it have made from what you said, and which of the model's real tool calls would it have blocked?
// Output contains your messages: it goes to bench/replay/out/ (git-ignored) and nowhere else.
//
//   PI_HEED_ENV_FILE=… node bench/replay/replay.ts [--sessions ~/.pi/agent/sessions] [--only substr] [--parallel 4]
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe } from "../../src/policy.ts";
import { FakePi, toolCall } from "../../test/harness.ts";
import { createHeed } from "../../src/index.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const root = arg("sessions", join(homedir(), ".pi/agent/sessions"))!;
const only = arg("only");
const parallel = Number(arg("parallel", "4"));
const outDir = join(new URL(".", import.meta.url).pathname, "out");
mkdirSync(outDir, { recursive: true });

const files = readdirSync(root, { recursive: true })
	.map(String)
	.filter((f) => f.endsWith(".jsonl") && (!only || f.includes(only)))
	.map((f) => join(root, f))
	.filter((f) => statSync(f).size > 2000);

const text = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n") : "";

interface Event { at: number; kind: string; [k: string]: unknown }

async function replay(file: string) {
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
	const pi = new FakePi();
	pi.cwd = lines.find((e: any) => e.type === "session")?.cwd ?? "/";
	const heed = createHeed(pi.api(), { env: { PI_HEED_ENV_FILE: process.env.PI_HEED_ENV_FILE ?? "", PI_HEED_MODE: "enforce", PI_JEV_CONTEXT_MODE: "off" }, judge: undefined, config: { maxInterventionsPerRun: 1e9 } });
	const events: Event[] = [];
	let userN = 0, calls = 0, inRun = false;
	const calledTools = new Map<string, { name: string; input: Record<string, unknown> }>();
	for (const e of lines) {
		if (e.type !== "message") continue;
		const m = e.message;
		if (m.role === "user") {
			const t = text(m.content).trim();
			if (!t || t.startsWith("/")) continue;
			if (inRun) await pi.emit("agent_end");
			userN++;
			const before = new Set(heed.engine.all().map((p) => p.id));
			// what pi-goal and similar extensions inject reaches pi-heed with source "extension"; the session file doesn't say
			if (/^\[[A-Z][A-Z _-]{3,}(?:\s+\w+=\S+)*\]/.test(t)) {
				pi.entries.push({ type: "message", id: `x${userN}`, message: { role: "user", content: t } });
				await pi.emit("input", { text: t, source: "extension" });
				await pi.emit("agent_start");
			} else await pi.user(t);
			await heed.settled();
			inRun = true;
			for (const p of heed.engine.all()) {
				if (!before.has(p.id)) events.push({ at: userN, kind: "rule", id: p.id, rule: describe(p), by: p.provenance.by, status: p.status, ended: p.provenance.endReason, quote: p.sourceQuote.slice(0, 300), message: t.slice(0, 600) });
			}
			for (const p of heed.engine.all()) if (before.has(p.id) && p.status !== "active" && p.provenance.endReason && !events.some((x) => x.kind === "end" && x.id === p.id)) events.push({ at: userN, kind: "end", id: p.id, rule: describe(p), reason: p.provenance.endReason, message: t.slice(0, 300) });
		}
		if (m.role === "assistant") {
			for (const part of m.content ?? []) {
				if (part?.type !== "toolCall") continue;
				calls++;
				calledTools.set(part.id, { name: part.name, input: part.arguments ?? {} });
				const r = await pi.emit("tool_call", { ...toolCall(part.name, part.arguments ?? {}), toolCallId: part.id });
				if (r?.block) events.push({ at: userN, kind: "block", tool: part.name, input: JSON.stringify(part.arguments ?? {}).slice(0, 300), reason: String(r.reason).slice(0, 400), active: heed.engine.active().map((p) => `${p.id} ${describe(p)}`) });
			}
		}
		if (m.role === "toolResult" && calledTools.has(m.toolCallId)) {
			const c = calledTools.get(m.toolCallId)!;
			await pi.emit("tool_result", { toolCallId: m.toolCallId, toolName: c.name, input: c.input, content: m.content, isError: !!m.isError });
		}
	}
	return { file: file.replace(root, ""), userMessages: userN, calls, events, finalActive: heed.engine.active().map((p) => `${p.id} ${describe(p)} ← "${p.sourceQuote.slice(0, 120)}"`) };
}

const queue = [...files];
const results: Awaited<ReturnType<typeof replay>>[] = [];
await Promise.all(Array.from({ length: parallel }, async () => {
	for (let f = queue.shift(); f; f = queue.shift()) {
		const t0 = Date.now();
		const r = await replay(f).catch((e) => ({ file: f!, userMessages: 0, calls: 0, events: [{ at: 0, kind: "error", error: String(e?.stack ?? e).slice(0, 500) }], finalActive: [] }));
		results.push(r);
		const n = (k: string) => r.events.filter((e) => e.kind === k).length;
		console.log(`${String(r.userMessages).padStart(4)} msgs ${String(r.calls).padStart(5)} calls  rules=${n("rule")} blocks=${n("block")}${n("error") ? " ERROR" : ""}  ${Math.round((Date.now() - t0) / 1000)}s  ${r.file.slice(0, 80)}`);
	}
}));
const outFile = arg("out", join(outDir, "replay.json"))!;
writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log(`\nsessions ${results.length}, messages ${results.reduce((a, r) => a + r.userMessages, 0)}, calls ${results.reduce((a, r) => a + r.calls, 0)}, rules ${results.reduce((a, r) => a + r.events.filter((e) => e.kind === "rule").length, 0)}, blocks ${results.reduce((a, r) => a + r.events.filter((e) => e.kind === "block").length, 0)} → ${outFile}`);
