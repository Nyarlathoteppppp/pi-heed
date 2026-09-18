<div align="center">

# pi-heed

**Your agent understood your instruction. pi-heed makes sure it still remembers.**

Runtime constraints for the [pi](https://pi.dev) coding agent: every side-effecting tool call is checked against what you said, before it runs.

[![pi](https://img.shields.io/badge/pi-%E2%89%A50.85.1-7c5cff)](https://pi.dev)
[![Jev](https://img.shields.io/badge/powered%20by-TypeSafe%20Jev-f5a524)](https://docs.typesafe.ai)
[![tests](https://img.shields.io/badge/tests-59%20passing-2ea043)](#development)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

You say *"review only, don't touch anything"*. Forty tool calls and one context compaction later, the agent reaches for `write`. pi-heed stops it — with your own words as the reason:

```
[pi-heed] User constraint c1 "Review only. Don't modify any files.". Pending call: bash: echo reviewed >> notes.txt.
It would change files or external state. Do not apply it; describe the intended change instead, or ask the user to lift the constraint.
```

And when you *did* change your mind — *"I've changed my mind for notes.txt only"* — it lets that one call through and keeps the rest locked.

## Why it's different

|  | typical guardrail | **pi-heed** |
|---|---|---|
| Rules come from | a static config file | **what you said in this conversation** (English & 中文) |
| Survives context compaction | — | **yes** — constraints are rebuilt from the session, not the model's memory |
| When it acts | after the damage, or by nagging | **before execution**, only on side effects |
| Why it acted | "blocked" | **evidence**: your quote + the exact call + the fix |
| Exceptions | all or nothing | *"except notes.txt"* is understood |
| Uncertain? | guesses | **abstains** (`insufficient`) or fails open |

## Built to use a fast decision model properly

[Jev](https://docs.typesafe.ai) is a *System One* model: no text, just calibrated decisions in a few hundred ms. pi-heed spends it where an LLM would be too slow and a regex too dumb:

- **⚡ Judged while the model is still typing.** pi parses tool arguments as they stream. For `edit`/`write`, the path streams before the file body, so pi-heed starts deciding once the path is complete, while the model is still writing the content. Other tools start at `toolcall_end`.
- **🧠 One call, many questions.** Each message you send gets a single background Jev request that asks at once: *did this set read-only? forbid tests? forbid deps? lift anything? is that "don't…" sentence a real prohibition?* It catches paraphrases like *"只看不改"* or *"hands off the code"* and drops fakes like *"don't forget to add tests"*.
- **⚖️ Second opinion before every block.** A rule wants to block? Jev first checks whether you carved out an exception for exactly this call. Only a confident *permitted* (p ≥ 0.9, confidence ≥ 0.8) gets through.
- **🔒 Deterministic where it matters.** Side-effect detection is rules, not vibes (Jev rated *"edit changes files"* at ~0.7 — so we don't ask it that).

Measured against live `~typesafe/jev-latest` (OpenRouter):

| | result | latency |
|---|---|---|
| Free-text constraint checks (prod API, `git push`, public API changes) | 6 / 6 correct | 235–1550 ms |
| Exception second opinion | 3 / 3 correct | 258–417 ms |
| Paraphrased constraints | *"只看不改"*: p ≥ 0.9 · *"hands off the code"*: 0.85 · non-constraints ≤ 0.03 | 280–980 ms |
| In real pi: exception granted, call pre-judged at `toolcall_end` | ✔ | tool call waited 189 ms |
| In real pi: `write` under read-only, judged from the streamed path | blocked | **tool call waited 0 ms** (Jev took 338 ms) |
| Cost per decision | ≈ $0.000017 | |

## Where the time goes

Measured, so you know what pi-heed costs you:

| | cost |
|---|---|
| pi-heed's own logic (rules, classification, extraction) | 1–46 µs |
| Network (TLS to OpenRouter; DNS only the first time) | 15–20 ms, plus 187 ms cold DNS once. Pre-warmed at session start |
| One Jev decision, 1 to 8 questions | median ~275 ms; question count barely matters |
| 8 questions split into 8 parallel requests | ~650 ms, so pi-heed never splits them |

Only `tool_call` can make pi wait, and only for a mutating call under an active constraint in **enforce** mode. **Shadow mode never waits**: it decides and logs in the background.

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
/heed status                     mode, judge, active constraints, budget
/heed mode <off|shadow|enforce>
/heed constraints
/heed add <text>                 add a free-text constraint by hand
/heed drop <id>
/heed log [n]                    recent decisions (with pre-judge / wait times)
/heed label <good|bad> [note]    label the latest decision for calibration
```

## Known limitations

- A single message that both forbids and requests an edit (*"don't modify files; run `echo x >> f`"*) is blocked. That's deliberate: pi-heed plays it safe.
- Shell side-effect detection is pattern-based; exotic commands can slip through.
- The exception check leans strict: after *"don't modify any files"*, a later *"use the write tool to create poem.md"* was judged `not_permitted` (p = 0.89). Say *"you can edit now"* or add an explicit exception.
- Jev is weak at recognising *lifts* (*"go ahead and implement it"*: p = 0.22), so lifts rely on rules plus the exception check.
- With [pi-loop-police](https://github.com/sebaxzero/pi-loop-police) installed, identical repeats are blocked before pi-heed sees them.

## Roadmap

- [ ] Suggest-only rollback to the last verified checkpoint (with [pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook))
- [ ] Benchmark: forgotten-constraint tasks after compaction, with vs. without pi-heed
- [ ] Threshold calibration from `/heed label` data

## Development

```bash
npm install
npm test                                        # 59 tests, no network
npm run typecheck
PI_HEED_ENV_FILE=~/.env npm run smoke:jev       # live Jev check
```

MIT © Nyarlathoteppppp
