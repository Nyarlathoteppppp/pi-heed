import { JevJudge, resolveTransport, type Question } from "../../src/judge.ts";
const j = new JevJudge(resolveTransport()!);
const qs = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, { type: "noul", instructions: `The user forbids action number ${i} (modifying files, tests, deps, network, git...)` } as Question]));
const small = { msg: "Don't modify any files." };
const big = { msg: "Don't modify any files. " + "Context line about the auth module and its handlers. ".repeat(60) }; // ~3.3KB
const time = async (state: unknown, q: Record<string, Question>) => { const s = performance.now(); await j.decide(state, q, new AbortController().signal); return performance.now() - s; };
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const run = async (label: string, f: () => Promise<number>, n = 5) => { const r: number[] = []; for (let i = 0; i < n; i++) r.push(await f()); console.log(`${label.padEnd(34)} median ${med(r).toFixed(0).padStart(4)}ms  [${r.map((x) => x.toFixed(0)).join(", ")}]`); };
await time(small, qs(1)); // warm connection
await run("1 question, small state", () => time(small, qs(1)));
await run("4 questions, small state", () => time(small, qs(4)));
await run("8 questions, small state", () => time(small, qs(8)));
await run("1 question, 3.3KB state", () => time(big, qs(1)));
await run("8 questions, 3.3KB state", () => time(big, qs(8)));
await run("8 parallel x 1 question (wall)", async () => { const s = performance.now(); await Promise.all(Array.from({ length: 8 }, () => time(small, qs(1)))); return performance.now() - s; });
