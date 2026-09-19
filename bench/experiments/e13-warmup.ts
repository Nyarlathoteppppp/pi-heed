import { JevJudge, resolveTransport } from "../../src/judge.ts";
const mode = process.argv[2];
const t = resolveTransport()!;
const j = new JevJudge(t);
const q = { q: { type: "noul" as const, instructions: "The user forbids pushing to a remote." } };
if (mode === "head") { j.warm(); await new Promise((r) => setTimeout(r, 1500)); }
if (mode === "decide") { await j.decide({ m: "ok" }, { w: { type: "noul", instructions: "Is `m` a greeting?" } }, AbortSignal.timeout(10000)); await new Promise((r) => setTimeout(r, 300)); }
if (mode !== "none") await new Promise((r) => setTimeout(r, 200));
const t0 = performance.now();
await j.decide({ user_message: "Don't push anything." }, q, AbortSignal.timeout(10000));
const first = performance.now() - t0;
const t1 = performance.now();
await j.decide({ user_message: "Don't push anything, really." }, q, AbortSignal.timeout(10000));
console.log(`${mode} first=${first.toFixed(0)} second=${(performance.now() - t1).toFixed(0)}`);
