import { JevJudge, resolveTransport } from "../../src/judge.ts";
const j = new JevJudge(resolveTransport()!);
const q = { q: { type: "noul" as const, instructions: "The user forbids pushing to a remote." } };
const call = async () => { const t0 = performance.now(); await j.decide({ user_message: `Don't push ${Math.random()}` }, q, AbortSignal.timeout(10000)); return Math.round(performance.now() - t0); };
await call();
for (const idle of [1, 3, 5, 8, 15, 30]) { await new Promise((r) => setTimeout(r, idle * 1000)); console.log(`after ${idle}s idle: ${await call()} ms`); }
