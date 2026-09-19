<div align="center">

# pi-heed

**Your agent understood your instruction. pi-heed makes sure it still remembers.**

Runtime constraints for the [pi](https://pi.dev) coding agent: every side-effecting tool call is checked against what you said, before it runs.

[![pi](https://img.shields.io/badge/pi-%E2%89%A50.85.1-7c5cff)](https://pi.dev)
[![Jev](https://img.shields.io/badge/powered%20by-TypeSafe%20Jev-f5a524)](https://docs.typesafe.ai)
[![tests](https://img.shields.io/badge/tests-109%20passing-2ea043)](#development)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

You say *"review only, don't touch anything"*. Forty tool calls and one context compaction later, the agent reaches for `write`. pi-heed stops it — with your own words as the reason:

```
[pi-heed] User constraint c1 "Review only. Don't modify any files.". Pending call: bash: echo reviewed >> notes.txt.
It would change files or external state. Do not apply it; describe the intended change instead, or ask the user to lift the constraint.
```

And when you *did* change your mind (*"I've changed my mind for notes.txt only"*), it lets that one file through and keeps everything else locked.

## Conversational policy, not a keyword list

What you say over a session is a policy that changes: *"don't touch src — but src/auth is fine — except secrets.ts"*, *"this once you can edit package.json"*, *"this round you can install deps"*, *"never mind, revoke that"*. pi-heed keeps it as structured state:

```ts
{ id, sourceQuote, effect, action, resource, scope, exceptions, status, provenance }
//      DENY | ALLOW | REQUIRE_CONFIRMATION | REQUIRE_BEFORE
//                     modify | install_deps | git_push | git_commit | custom
//                               "*" | "tests" | path/dir
//                                         session | goal | run | once
//                                                             active | superseded | expired
```

| You say | What happens |
|---|---|
| *"不要改测试"* | ADD `DENY modify tests` |
| *"现在测试可以改了"* | LIFT: the deny becomes `superseded`, with your words as the reason |
| *"其他都别改，但 notes.txt 可以"* | `DENY modify *` + `ALLOW modify notes.txt` |
| *"src 不能改，但 src/auth 可以，不过 secrets.ts 还是不能动"* | nested: the most specific rule wins per file |
| *"这一次可以改 package.json"* / *"这一轮可以装依赖"* | `once` (expires after the first use) / `run` (expires when the run ends) |
| *"刚才允许的取消，继续不要改测试"* | RE-APPLY: the permission is superseded, the deny comes back |
| *"ask me before pushing"* / *"push 前先跑测试"* | `REQUIRE_CONFIRMATION git_push` / `REQUIRE_BEFORE git_push` until tests pass with no change since |

Resolution per call: the most specific resource wins (file > dir > tests > everything), then the more specific action, then the newer instruction. Nothing is deleted. Every change is an op persisted in the session, so after a reload or compaction the state replays to exactly what it was, without calling Jev again.

**Jev's job is narrow.** It never writes a policy. For each message it classifies how each existing policy changed (`KEEP / LIFT / NARROW / EXCEPTION / REPLACE / UNKNOWN`), asks whether this is your go-ahead to start changing things, and answers a few signals (new prohibition? temporary permission? new task?). Finite situations get a fixed option set with an explicit `unclear`. pi-heed applies only confident answers, and takes resources from your message, never from Jev. Anything uncertain changes nothing. A free-text prohibition is also asked once which tools cannot break it, so those calls skip the per-call check.

## Benchmark

55 scripted sessions and 208 labelled decisions: basics, lifecycle, long sessions with compaction, adversarial input, and cases taken from the author's real sessions. Replayable offline from a recorded cassette. [Details and method →](bench/README.md)

| | recall | false block | lifecycle | task success | cost / task |
|---|---|---|---|---|---|
| v0.3.0 + Jev | 71.4% | 5.2% | 70.5% | 61.2% | $0.000051 |
| v0.4.0 + Jev | 95.2% | 0.6% | 95.5% | 93.9% | $0.000049 |
| v0.5.1 + Jev | 97.6% | 0.0% | 100% | 98.0% | $0.000038 |
| **v0.6.0, rules only** | 89.1% | 1.9% | 93.2% | 85.5% | $0 |
| **v0.6.0 + Jev** | **97.8%** | **0.0%** | **100%** | **98.2%** | $0.000040 |

Sessions with at least one false block: 16.3% (v0.3) → **0.0%**. Two cases sit at a threshold and flip between live
recordings. From v0.6 the benchmark includes six cases from real sessions (6/6). v0.6.0 rules-only numbers are
lower than v0.5's only because the new real-session cases are harder.

### Does it matter with a real model?

36 real pi sessions with `dragon-grok-4.6` ([bench/live/](bench/live/README.md)): six small repos, each tempting the model to break a
constraint stated in an earlier turn, with pi-heed off vs enforce. Outcomes are read from git, not from the model.

| | model broke the constraint: pi-heed off | pi-heed enforce | false blocks |
|---|---|---|---|
| constraint stated once, unchanged (5 scenarios) | 0 / 15 | 0 / 15 | 0 |
| **constraint changed mid-session** ("only `math.js`" → "make sure the tests pass") | **3 / 3** | **0 / 3** | 0 |

A simple rule, this model keeps on its own. A rule that changed during the conversation, it broke every time,
and pi-heed caught every time without blocking the allowed work. That is what pi-heed is for.

## Experiment report: using a fast decision model well

[Jev](https://docs.typesafe.ai) is a *System One* model: no text, just calibrated decisions in a few hundred ms. TypeSafe's
own principle, *code handles control flow; Jev provides common-sense perception*, is how pi-heed is built: the policy
engine decides, Jev only answers narrow questions about what a message means. We
measured every judgement pi-heed asks it for (70 labelled items, 108 cross-kind pairs, 49 benchmark sessions), checked against TypeSafe's own authoring guidelines, and
changed the design where the data said so. The full log, including the result that reversed an earlier
conclusion, is in **[EXPERIMENTS.md](EXPERIMENTS.md)** (E01–E12). Per-judgement tables are in [bench/JEV-LAB.md](bench/JEV-LAB.md).

**What we found, and what we changed because of it**

| # | Finding | Evidence | What pi-heed does |
|---|---|---|---|
| 1 | **The probabilities are calibrated**, slightly underconfident at the top | p 0.9–1.0 → 98% true · 0.7–0.9 → 94% · 0–0.1 → 7% | Treats p as a probability; thresholds (0.9) are conservative on purpose |
| 2 | **Latency is flat in the number of questions**; parallel requests are slower | 1 / 4 / 8 questions: 274 / 273 / 276 ms · 8 parallel: ~650 ms | Everything about a message goes in one request |
| 3 | **The only latency lever is *when* you ask** | pi-heed's own code: 1–46 µs · Jev floor ~250 ms | Pre-judges while the model streams (edit/write from the path alone); shadow mode never waits. Real pi: blocked a `write` after **0 ms** wait |
| 4 | **Ask about intent, not a taxonomy** | lift detection: `KEEP/LIFT/NARROW…` 71% → *"is this your go-ahead?"* **93%**, confident answers 100% right | Go-ahead question for lifts ("Ship it", "按你的方案改吧" now work) |
| 5 | **Jev anchors on what it reads first** | exception check with the call and messages *before* the old constraint: confident answers 75% → **100%** right | Field order + "later messages override earlier ones" |
| 6 | **Ask exactly what you mean: "explicitly forbidden" ≠ "implied"** | *"may the assistant modify tests?"* after "look but don't touch" → "forbidden" (implied, not stated): 27/91 false adds | Asks whether the user *explicitly* forbade it; every choice has an `unclear` escape |
| 7 | **TypeSafe's structured question format helps for some judgements, not all** | read-only 7/9 → **9/9**, tool relevance 5/8 → **8/8** safe skips, 0 wrong; go-ahead and exception checks got *worse* | Structured `{question, focus}` + `true/false` criteria where it measured better, prose elsewhere |
| 8 | **Voting doesn't fix blind spots** | errors are correlated across phrasings; averaging mostly cost coverage | Better questions instead of ensembles |
| 9 | **Don't ask Jev what the rules already know** | "an edit changes files": p ≈ 0.7 | Side effects, paths and scopes are deterministic rules; Jev only judges meaning |
| 11 | **One request, one state: isolate a question that other context distracts** | go-ahead inside the shared state caught 5/9 lifts; in its own minimal request **8/9**, 0 false | go-ahead asked in a parallel request with only the message and the earlier rule |
| 10 | **Only Jev-decided calls compound, so decide fewer** | deterministic decisions never erred · Jev-influenced decisions per benchmark: 52 → **12** with a per-prohibition tool-relevance check | Asks once per prohibition which tools can't break it, and skips those calls (0 wrong skips) |

Cost stayed negligible throughout: ≈ $0.00004 per session, about 1.7 Jev calls.

## Why it's different

|  | typical guardrail | **pi-heed** |
|---|---|---|
| Rules come from | a static config file | **what you said in this conversation** (English & 中文) |
| Survives context compaction | — | **yes** — constraints are rebuilt from the session, not the model's memory |
| When it acts | after the damage, or by nagging | **before execution**, only on side effects |
| Why it acted | "blocked" | **evidence**: your quote + the exact call + the fix |
| Exceptions | all or nothing | *"except notes.txt"* is understood |
| Uncertain? | guesses | **abstains** (`insufficient`) or fails open |

## Install

```bash
pi install git:github.com/Nyarlathoteppppp/pi-heed
```

Rules work immediately. For the semantic layer, give it a Jev key (see below). It starts in **shadow mode**: it decides and logs, but never interferes until you say so:

```
/heed mode enforce
```

## What it checks

| Constraint you state | Example | Decided by |
|---|---|---|
| Read-only | *"review only"*, *"不要改代码"*, *"hands off"* | rules + Jev |
| Don't touch tests | *"don't touch the tests"*, *"别动测试"* | rules + Jev |
| No new dependencies | *"no new deps"*, *"不要引入新依赖"* | rules + Jev |
| Protected path | *"don't edit src/config.ts"*, *"别改 package.json"* | rules |
| Anything else | *"never call the production API"*, *"don't push to GitHub"* | Jev: `violates` / `complies` / `insufficient` |
| Blind retries | same command, same error, nothing changed | rules — appends evidence to the failing result |

Reads (`read`, `grep`, `find`, `ls`, non-mutating shell) are never checked.

## Safety properties

- **Shadow by default.** `off` · `shadow` · `enforce`, persisted per session.
- **Fails open.** Jev error or timeout (2.5 s) → pi behaves as if pi-heed weren't installed.
- **Never starts a turn.** It blocks a call or annotates a result; it never re-prompts the model. Esc stays Esc.
- **Stale-proof.** A verdict that lands after you pressed Esc or sent a new prompt is discarded.
- **Budgeted.** At most 3 interventions per agent run.
- **Only your words count.** Text injected by extensions (including pi-heed) never becomes a constraint.
- **Cache-friendly.** No context rewriting; evidence rides on the blocked call or the failing result.

## Jev key

Semantic checks need one of:

| Variable | Endpoint | Default model |
|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter Decisions API | `~typesafe/jev-latest` (follows the newest Jev) |
| `TYPESAFE_API_KEY` | api.typesafe.ai | `jev-latest` |
| `PI_HEED_ENV_FILE` | read either key from a dotenv file | |
| `PI_HEED_MODEL` | pin a version | |

**What leaves your machine** (only when a key is set): each message you type, for constraint understanding; and for mutating calls under a constraint, the constraint text plus the call (arguments truncated to 1500 chars; they can contain code).

## Commands

```
/heed status                     mode, judge, active policies, budget
/heed policies                   the resolved policy right now
/heed history                    superseded and expired policies, and why they ended
/heed explain <id>               which of your sentences a policy came from, its exceptions
/heed mode <off|shadow|enforce>
/heed add <text>                 add a free-text prohibition by hand
/heed drop <id>
/heed log [n]                    recent decisions (with pre-judge / wait times)
/heed label <good|bad> [note]    label the latest decision for calibration
```

## Known limitations

- A free-text prohibition is only enforced when Jev is confident (p ≥ 0.9, confidence ≥ 0.8). *"Don't send notifications"* vs a Slack webhook `curl` scored 0.76–0.88 and ran. That is fail-open by design.
- *"Don't delete any data"* is judged violated by `rm -rf dist/` (p = 0.97). Whether build output is "data" is arguable.
- A single message that both forbids and requests an edit (*"don't modify files; run `echo x >> f`"*) is blocked.
- Shell and inline-code side-effect detection is pattern-based; exotic commands can slip through.
- `goal` scope only ends when Jev says a message starts a new task. Without a key it behaves like `session`.
- The live benchmark so far covers one model (dragon-grok-4.6) and six scenarios.

## Roadmap

- [ ] Suggest-only rollback to the last verified checkpoint (with [pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook))
- [x] Benchmark: lifecycle, long sessions, compaction, adversarial ([bench/](bench/README.md))
- [x] Fewer Jev-decided calls per session: per-policy tool relevance (E07)
- [x] Fix what real sessions showed (E11 → v0.6): scratch files, design guidance, implicit lifts, inline code, extension tools
- [ ] Live benchmark across more models and more changing-policy scenarios
- [ ] Faster labelling (`/heed review`), then recalibrate thresholds from real sessions; E05 suggests 0.9 is conservative
- [ ] Threshold calibration from `/heed label` data

## Development

```bash
npm install
npm test                                        # 109 tests, no network
node bench/run.ts --judge replay                # benchmark, offline
npm run typecheck
PI_HEED_ENV_FILE=~/.env npm run smoke:jev       # live Jev check
```

MIT © Nyarlathoteppppp
