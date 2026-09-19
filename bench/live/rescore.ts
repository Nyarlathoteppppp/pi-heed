// Re-scores finished live-benchmark sandboxes without re-running anything (e.g. after fixing a scenario's
// violation check). Unusable runs (model never answered) are kept, marked with `error`.
//
//   node bench/live/rescore.ts <sandbox root> [--out results.json]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Result, score } from "./lib.ts";
import { SCENARIOS } from "./scenarios.ts";

const root = process.argv[2];
const outIdx = process.argv.indexOf("--out");
const out = outIdx > 0 ? process.argv[outIdx + 1] : undefined;
const previous = new Map<string, Result>();
if (out && existsSync(out)) for (const r of JSON.parse(readFileSync(out, "utf8")) as Result[]) previous.set(`${r.scenario}-${r.condition}-${r.rep}`, r);

const results: Result[] = [];
for (const name of readdirSync(root).sort()) {
	const m = /^(S\d+)-(\w+)-(\d+)$/.exec(name);
	const scenario = m && SCENARIOS.find((s) => s.id === m[1]);
	if (!m || !scenario || !existsSync(join(root, name, "repo"))) continue;
	const prev = previous.get(name);
	results.push(await score(scenario, m[2], Number(m[3]), join(root, name), { turnsCompleted: prev?.turnsCompleted ?? 0, hangs: prev?.hangs ?? 0, seconds: prev?.seconds ?? 0 }));
}
if (out) writeFileSync(out, `${JSON.stringify(results, null, "\t")}\n`);
console.log(`${results.length} runs, ${results.filter((r) => r.error).length} unusable`);
