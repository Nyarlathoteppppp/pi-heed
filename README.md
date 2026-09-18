# pi-heed

**Make your [pi](https://pi.dev) agent heed what you said.**

pi-heed tracks the constraints you state in conversation — *"read-only"*, *"don't touch the tests"*, *"no new dependencies"*, *"never call the production API"* — and checks side-effecting tool calls against them **before** they run. It also flags blind retries: the same command failing with the same error while nothing changed in between.

Every intervention carries evidence: your own words, the pending call, and why it conflicts. Nothing is silently overridden, and pi-heed never starts a turn on its own.

```
[pi-heed] User constraint c1 "Review only. Don't modify any files.". Pending call: bash: echo reviewed >> notes.txt.
It would change files or external state. Do not apply it; describe the intended change instead, or ask the user to lift the constraint.
```

## Install

```bash
pi install git:github.com/Nyarlathoteppppp/pi-heed
```

or try it for one session: `pi -e /path/to/pi-heed/src/index.ts`

## Modes

| Mode | Behaviour |
|---|---|
| `shadow` (default) | Decides and logs, never interferes. Status line shows `would block …`. |
| `enforce` | Blocks violating tool calls; appends evidence to repeated failures. |
| `off` | Does nothing. |

Switch with `/heed mode enforce` (persisted in the session) or `PI_HEED_MODE=enforce`.

## How it decides

| Check | Decided by | Acts when |
|---|---|---|
| read-only, no-tests, no-deps, protected path | Deterministic rules on the tool call (`edit`/`write`, mutating shell commands, package installs, test paths) | Rule matches |
| Free-text constraints (*"never call the production API"*) | [TypeSafe Jev](https://docs.typesafe.ai) Choice: `violates` / `complies` / `insufficient` | `violates` with p ≥ 0.9 **and** confidence ≥ 0.8 |
| Blind retry | Same normalised command + same error signature + no successful file change since | 2nd identical failure (once) |

- Reads (`read`, `grep`, `find`, `ls`, non-mutating shell) are never checked.
- `insufficient` is an abstention, not a block.
- Jev errors or timeouts (2.5 s) fail open: pi behaves as if pi-heed were not installed.
- A verdict that arrives after you pressed Esc or started a new prompt is discarded.
- At most 3 interventions per agent run.
- Only text you type becomes a constraint; messages injected by extensions (including pi-heed) never do. Saying *"you can edit now"* / *"现在可以改了"* lifts read-only.

Constraint extraction understands English and Chinese.

## Jev key

Semantic checks need one of (rules work without any key):

- `OPENROUTER_API_KEY` — uses `~typesafe/jev-latest` via OpenRouter's Decisions API (auto-follows the newest Jev)
- `TYPESAFE_API_KEY` — uses `jev-latest` on api.typesafe.ai
- `PI_HEED_ENV_FILE=/path/to/.env` — read either key from a dotenv file
- `PI_HEED_MODEL` — pin a model version

**What is sent:** only for mutating calls when free-text constraints exist — the constraint text and the pending tool call (tool name, summary, arguments truncated to 1500 chars). Arguments can contain code; don't use free-text constraints in sessions whose edits must not leave your machine.

## Commands

```
/heed status                 mode, judge, active constraints, budget
/heed mode <off|shadow|enforce>
/heed constraints
/heed add <text>             add a free-text constraint by hand
/heed drop <id>
/heed log [n]                recent decisions on this branch
/heed label <good|bad> [note]  label the latest decision (for threshold calibration)
```

Decisions are stored as session custom entries (`heed`, `heed-label`), never sent to the model.

## Known limitations (v0.1)

- Scoped exceptions aren't understood: *"I changed my mind for notes.txt only"* does not lift a read-only constraint.
- Shell side-effect detection is pattern-based; exotic commands can slip through (and are then treated as non-mutating).
- If [pi-loop-police](https://github.com/sebaxzero/pi-loop-police) is installed, it blocks identical repeated calls first, so pi-heed's repeat check rarely fires.
- No rollback yet — planned as *suggest-only*, executed by you.

## Development

```bash
npm install
npm test            # node --test, no network
npm run typecheck
PI_HEED_ENV_FILE=~/.env npm run smoke:jev   # live Jev check, 6 cases
```

MIT
