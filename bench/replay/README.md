# Replay your own pi sessions

Runs every session in `~/.pi/agent/sessions` through pi-heed (enforce, Jev, no intervention budget) without
executing anything, and reports which rules it would have made and which of the model's real tool calls it would
have blocked.

```bash
PI_HEED_ENV_FILE=/path/to/.env node bench/replay/replay.ts [--only <substring>] [--parallel 4] [--out file]
node bench/replay/analyze.ts [file]     # blocks grouped by the rule, with your sentence and example calls
```

Output contains your messages and goes to `bench/replay/out/` (git-ignored). Your messages are sent to Jev, as they
are when pi-heed runs. Counts overstate: the replayed model was never blocked, so after one missed lift every later
call counts. See E17 in [EXPERIMENTS.md](../../EXPERIMENTS.md).
