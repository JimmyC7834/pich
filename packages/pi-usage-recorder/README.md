# @jc4649/pi-usage-recorder

Observe-only token & context telemetry for a [pi](https://github.com/earendil-works/pi) coding-agent session. Changes nothing the model sees — it only records.

## What it does

Appends one row per assistant turn to `<cwd>/.pi/usage/usage.jsonl`: full token counts, cache read/write split, cost, and context-fill %. This lets you analyze a session's spend trend offline, or A/B a context-management extension (compare `usage.jsonl` with it off vs on).

It registers no `context`/prompt rewrite — purely a measurement foundation. Fail-open everywhere: a dropped row or failed command never disrupts the agent.

## Commands
- `/usage` — usage for the current session.
- `/usage all` — every recorded session.

## Configuration
- `USAGE_RECORDER_DISABLE` — set to disable recording entirely.

## Install
```
pi install @jc4649/pi-usage-recorder
```

MIT
