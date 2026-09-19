// pi-heed benchmark runner.
//
//   node bench/run.ts                     rules only, no network
//   node bench/run.ts --judge replay      Jev answers from bench/cassette.json (offline, deterministic)
//   node bench/run.ts --judge record      live Jev, (re)records the cassette
//   node bench/run.ts --judge live        live Jev, cassette untouched
//   --impl baseline                       run the v0.3.0 implementation (bench/.baseline, see README)
//   --realtime                            replay with the recorded Jev latency (for latency numbers)
//   --json out.json                       write machine-readable results
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JevJudge, type Judge, resolveTransport } from "../src/judge.ts";
import { FakePi, toolCall } from "../test/harness.ts";
import { type Case, CASES, type Step } from "./cases.ts";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, fallback?: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] ?? "") : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const judgeMode = arg("judge", "none") as "none" | "replay" | "record" | "live";
const impl = arg("impl", "current") as "current" | "baseline";
const cassettePath = join(here, impl === "current" ? "cassette.json" : `cassette.${impl}.json`);
const realtime = flag("realtime");

type Cassette = Record<string, { status: number; body: string; ms: number }> & { _meta?: { url: string; model: string } };
const cassette: Cassette = existsSync(cassettePath) ? JSON.parse(readFileSync(cassettePath, "utf8")) : {};
// Cassettes remember which endpoint they were recorded against (request bodies differ by provider).
// Cassettes from before this field were recorded via OpenRouter.
const recorded = (cassette._meta as { url: string; model: string } | undefined) ?? { url: "https://openrouter.ai/api/alpha/decisions", model: "~typesafe/jev-latest" };
let dirty = false;

interface Meter {
	calls: number;
	cost: number;
	misses: number;
}
const meter: Meter = { calls: 0, cost: 0, misses: 0 };

/** fetch that records to / replays from the cassette and meters Jev calls. */
function cassetteFetch(): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		if (init?.method !== "POST") return new Response(null, { status: 204 }); // warm-up HEAD
		const body = String(init.body ?? "");
		const key = createHash("sha1").update(`${url}\n${body}`).digest("hex");
		meter.calls++;
		let hit = (cassette as Record<string, { status: number; body: string; ms: number }>)[key];
		if (!hit || judgeMode === "live" || judgeMode === "record") {
			if (judgeMode === "replay") {
				meter.misses++;
				throw new Error("cassette miss");
			}
			const t0 = performance.now();
			const res = await fetch(url, init);
			const text = await res.text();
			hit = { status: res.status, body: text, ms: Math.round(performance.now() - t0) };
			if (judgeMode === "record" && res.ok) {
				(cassette as Record<string, unknown>)[key] = hit;
				dirty = true;
			}
		} else if (realtime) {
			await new Promise((r) => setTimeout(r, hit!.ms));
		}
		try {
			// OpenRouter reports usage.cost; TypeSafe's own API reports tokens only ($0.042 per million input tokens).
			const usage = JSON.parse(hit.body)?.usage ?? {};
			meter.cost += typeof usage.cost === "number" ? usage.cost : (usage.input_tokens ?? 0) * 0.042e-6;
		} catch {}
		return new Response(hit.body, { status: hit.status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}

function makeJudge(): Judge | null {
	if (judgeMode === "none") return null;
	if (judgeMode === "replay") return new JevJudge({ ...recorded, key: "replay" }, cassetteFetch());
	const t = resolveTransport();
	if (!t) throw new Error("no Jev key: set PI_HEED_ENV_FILE, TYPESAFE_API_KEY or OPENROUTER_API_KEY");
	if (judgeMode === "record") {
		for (const k of Object.keys(cassette)) delete (cassette as Record<string, unknown>)[k];
		cassette._meta = { url: t.url, model: t.model };
		dirty = true;
	}
	return new JevJudge(t, cassetteFetch());
}

const implPath = impl === "baseline" ? "./.baseline/src/index.ts" : impl === "current" ? "../src/index.ts" : `./.${impl}/src/index.ts`;
const { createHeed } = (await import(implPath)) as typeof import("../src/index.ts");

interface Decision {
	case: string;
	cat: Case["cat"];
	semantic: boolean;
	expect: "allow" | "block";
	got: "allow" | "block";
	ms: number;
	/** Jev's answer took part in this decision (exception check or free-text check). */
	jev: boolean;
}

const verbose = flag("verbose");
const traces = new Map<string, string[]>();

async function runCase(c: Case, judge: Judge | null): Promise<Decision[]> {
	const config = { mode: "enforce" as const, maxInterventionsPerRun: 1000, judgeTimeoutMs: 5000 };
	let pi = new FakePi();
	pi.tools = c.tools ?? [];
	let heed = createHeed(pi.api(), { judge, config, env: { PI_HEED_PIPELINE: "interpret" } });
	await pi.emit("session_start", { reason: "startup" });
	const out: Decision[] = [];
	let started = false;

	const exec = async (tool: string, input: Record<string, unknown>, expect?: "allow" | "block") => {
		const tc = toolCall(tool, input);
		// the model streams the call first; pi-heed may pre-judge at toolcall_end
		await pi.emit("message_update", { assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: tc.toolCallId, name: tool, arguments: input } } });
		const mark = pi.entries.length;
		const t0 = performance.now();
		const r = await pi.emit("tool_call", tc);
		const ms = performance.now() - t0;
		const got = r?.block ? "block" : "allow";
		const gate = pi.entries.slice(mark).find((e) => e.customType === "heed" && e.data.kind === "gate")?.data;
		const jev = !!gate && (gate.verdict?.by === "jev" || !!gate.exception);
		if (got === "allow") await pi.emit("tool_result", { ...tc, isError: false, content: [{ type: "text", text: "ok" }] });
		if (expect) out.push({ case: c.id, cat: c.cat, semantic: !!c.semantic, expect, got, ms, jev });
	};

	for (const step of c.steps as Step[]) {
		if ("u" in step) {
			if (started) await pi.emit("agent_end", { messages: [] });
			started = true;
			await pi.user(step.u);
			await heed.settled(); // a real model takes longer than Jev before its first tool call
		} else if ("ext" in step) {
			await pi.emit("input", { text: step.ext, source: "extension" });
			pi.entries.push({ type: "message", id: `ext${pi.entries.length}`, message: { role: "user", content: step.ext } });
		} else if ("output" in step) {
			const tc = toolCall("read", { path: "file" });
			await pi.emit("tool_result", { ...tc, isError: false, content: [{ type: "text", text: step.output }] });
		} else if ("filler" in step) {
			for (let i = 0; i < step.filler; i++) {
				if (i % 3 === 0) await exec("read", { path: `src/f${i}.ts` });
				else if (i % 3 === 1) await exec("bash", { command: "ls -la src" });
				else await exec("grep", { pattern: `TODO${i}` });
			}
		} else if ("compact" in step) {
			// Strictest form of compaction: a fresh pi-heed that only has the session to go on.
			const entries = pi.entries;
			pi = new FakePi();
			pi.entries = entries;
			pi.tools = c.tools ?? [];
			heed = createHeed(pi.api(), { judge, config, env: { PI_HEED_PIPELINE: "interpret" } });
			await pi.emit("session_start", { reason: "resume" });
		} else {
			await exec(step.call[0], step.call[1], step.expect);
		}
	}
	if (verbose) {
		traces.set(
			c.id,
			pi.entries
				.filter((e) => e.customType === "heed")
				.map((e) => {
					const d = e.data;
					if (d.kind === "gate") return `    gate ${d.summary} → ${d.acted ? "BLOCK" : "allow"}${d.policy ? ` [${d.policy}]` : ""}${d.verdict ? ` ${d.verdict.decision}/${d.verdict.by} p=${d.verdict.probability?.toFixed?.(2)} c=${d.verdict.confidence?.toFixed?.(2)}` : ""}${d.exception ? ` exception=${d.exception.choice} p=${d.exception.p.toFixed(2)} c=${d.exception.confidence.toFixed(2)}` : ""}${d.error ? ` err=${d.error}` : ""}`;
					if (d.kind === "constraint") return `    policy ${[...(d.constraints ?? []), ...Object.entries(d.deltas ?? {}).map(([k, v]: [string, any]) => `delta ${k}=${v.kind} p=${v.p.toFixed(2)} c=${v.confidence.toFixed(2)}${v.applied ? " APPLIED" : ""}`)].join(" | ")}`;
					return `    ${d.kind}`;
				}),
		);
	}
	return out;
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const quantile = (xs: number[], q: number) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

const judge = makeJudge();
const all: Decision[] = [];
const perCase: Array<{ id: string; cat: string; title: string; ok: boolean; wrong: string[]; jevCalls: number; cost: number }> = [];
for (const c of CASES) {
	const before = { ...meter };
	const ds = await runCase(c, judge);
	all.push(...ds);
	const wrong = ds.filter((d) => d.expect !== d.got).map((d) => `expected ${d.expect}, got ${d.got}`);
	perCase.push({ id: c.id, cat: c.cat, title: c.title, ok: wrong.length === 0, wrong, jevCalls: meter.calls - before.calls, cost: meter.cost - before.cost });
}
if (dirty) writeFileSync(cassettePath, `${JSON.stringify(cassette, null, "\t")}\n`);

const shouldBlock = all.filter((d) => d.expect === "block");
const shouldAllow = all.filter((d) => d.expect === "allow");
const lifecycle = all.filter((d) => d.cat === "B");
const mutatingMs = all.map((d) => d.ms);
const metrics = {
	impl,
	judge: judgeMode,
	cases: CASES.length,
	decisions: all.length,
	recall: shouldBlock.filter((d) => d.got === "block").length / shouldBlock.length,
	falseBlockRate: shouldAllow.filter((d) => d.got === "block").length / shouldAllow.length,
	lifecycleAccuracy: lifecycle.filter((d) => d.got === d.expect).length / lifecycle.length,
	taskSuccess: perCase.filter((c) => c.ok).length / perCase.length,
	latencyP50ms: quantile(mutatingMs, 0.5),
	latencyP95ms: quantile(mutatingMs, 0.95),
	jevCallsPerTask: meter.calls / CASES.length,
	/** Sessions with at least one wrong decision: what a user actually experiences. */
	sessionsWithFalseBlock: perCase.filter((c) => c.wrong.some((w) => w.includes("expected allow"))).length / perCase.length,
	sessionsWithMissedViolation: perCase.filter((c) => c.wrong.some((w) => w.includes("expected block"))).length / perCase.length,
	/** Error rate of the decisions Jev took part in; only these compound independently per call. */
	jevDecisions: all.filter((d) => d.jev).length,
	jevDecisionErrors: all.filter((d) => d.jev && d.got !== d.expect).length,
	deterministicDecisions: all.filter((d) => !d.jev).length,
	deterministicErrors: all.filter((d) => !d.jev && d.got !== d.expect).length,
	costPerTaskUsd: meter.cost / CASES.length,
	cassetteMisses: meter.misses,
	byCategory: Object.fromEntries(
		(["A", "B", "C", "D", "E", "F"] as const).map((cat) => {
			const ds = all.filter((d) => d.cat === cat);
			return [cat, { decisions: ds.length, correct: ds.filter((d) => d.got === d.expect).length, tasks: perCase.filter((c) => c.cat === cat).length, tasksOk: perCase.filter((c) => c.cat === cat && c.ok).length }];
		}),
	),
};

console.log(`\npi-heed benchmark · impl=${impl} · judge=${judgeMode}${realtime ? " · realtime" : ""}`);
console.log(`cases ${metrics.cases}, decisions ${metrics.decisions}${meter.misses ? `, cassette misses ${meter.misses}` : ""}\n`);
console.log(`violation prevention recall   ${pct(shouldBlock.filter((d) => d.got === "block").length, shouldBlock.length)}  (${shouldBlock.filter((d) => d.got === "block").length}/${shouldBlock.length})`);
console.log(`false block rate              ${pct(shouldAllow.filter((d) => d.got === "block").length, shouldAllow.length)}  (${shouldAllow.filter((d) => d.got === "block").length}/${shouldAllow.length})`);
console.log(`lifecycle accuracy (B)        ${pct(lifecycle.filter((d) => d.got === d.expect).length, lifecycle.length)}`);
console.log(`task success                  ${pct(perCase.filter((c) => c.ok).length, perCase.length)}  (${perCase.filter((c) => c.ok).length}/${perCase.length})`);
console.log(`added latency p50 / p95       ${metrics.latencyP50ms.toFixed(1)} / ${metrics.latencyP95ms.toFixed(1)} ms  (tool_call wait, labelled calls)`);
console.log(`Jev calls per task            ${metrics.jevCallsPerTask.toFixed(2)}`);
console.log(`cost per task                 $${metrics.costPerTaskUsd.toFixed(6)}`);
const jd = all.filter((d) => d.jev);
const jErr = jd.filter((d) => d.got !== d.expect).length;
console.log(`\nsessions with ≥1 false block    ${pct(perCase.filter((c) => c.wrong.some((w) => w.includes("expected allow"))).length, perCase.length)}`);
console.log(`sessions with ≥1 missed block  ${pct(perCase.filter((c) => c.wrong.some((w) => w.includes("expected block"))).length, perCase.length)}`);
console.log(`deterministic decisions        ${all.length - jd.length}, wrong ${all.filter((d) => !d.jev && d.got !== d.expect).length}  (same input → same answer: errors don't compound per call)`);
console.log(`Jev-influenced decisions       ${jd.length}, wrong ${jErr}  (${jd.length ? ((100 * jErr) / jd.length).toFixed(1) : "0"}% — these compound: 1-(1-e)^n over n such calls)`);
console.log(`\nby category: ${Object.entries(metrics.byCategory).map(([k, v]) => `${k} ${v.tasksOk}/${v.tasks}`).join("  ")}`);
const failed = perCase.filter((c) => !c.ok);
if (failed.length) {
	console.log("\nfailed cases:");
	for (const f of failed) {
		console.log(`  ${f.id} ${f.title}: ${f.wrong.join("; ")}`);
		if (verbose) for (const t of traces.get(f.id) ?? []) console.log(t);
	}
}
const jsonOut = arg("json");
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ metrics, perCase }, null, "\t")}\n`);
