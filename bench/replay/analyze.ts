// Groups replay blocks by the rule that caused them. node bench/replay/analyze.ts [replay.json]
import { readFileSync } from "node:fs";
import { join } from "node:path";
const file = process.argv[2] ?? join(new URL(".", import.meta.url).pathname, "out", "replay.json");
const results = JSON.parse(readFileSync(file, "utf8"));
const byRule = new Map<string, { n: number; session: string; examples: string[]; quote: string }>();
let blocks = 0, rules = 0, dropped = 0;
for (const r of results) {
	const quotes = new Map<string, string>();
	for (const e of r.events) {
		if (e.kind === "rule") {
			rules++;
			if (e.status !== "active" && /not a restriction|design guidance|not a prohibition/.test(e.ended ?? "")) dropped++;
			quotes.set(e.id, e.quote);
		}
		if (e.kind !== "block") continue;
		blocks++;
		const id = /policy (p\d+)/.exec(e.reason)?.[1] ?? /\[(p\d+)\]/.exec(e.reason)?.[1] ?? "?";
		const key = `${r.file.slice(0, 40)}|${id}`;
		const g = byRule.get(key) ?? { n: 0, session: r.file.split("/")[1]?.slice(0, 40) ?? "", examples: [], quote: quotes.get(id) ?? e.reason.slice(0, 160) };
		g.n++;
		if (g.examples.length < 3) g.examples.push(`${e.tool} ${e.input.slice(0, 110)}`);
		byRule.set(key, g);
	}
}
console.log(`sessions ${results.length} · rules made ${rules} (Jev dropped ${dropped}) · blocks ${blocks}\n`);
for (const [key, g] of [...byRule].sort((a, b) => b[1].n - a[1].n)) {
	console.log(`${String(g.n).padStart(4)}× ${key.split("|")[1]} [${g.session}]  ← "${g.quote.replace(/\s+/g, " ").slice(0, 150)}"`);
	for (const x of g.examples) console.log(`        ${x.replace(/\s+/g, " ")}`);
}
