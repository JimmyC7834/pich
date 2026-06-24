# @jc4649/pi-autocompact

> Formerly **deepseek-compact**.

Proactive, low-cost context compaction for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Three lightweight but effective parts:

1. **Early trigger** — compacts at 50% of the context window (capped at 256K tokens), far sooner than pi's default (`window − 16K`), so you rarely hit a hard wall mid-task.
2. **Configurable summarizer** — summarizes with a cheap model instead of your expensive conversation model. Default **DeepSeek V4 Flash**; override with `PI_AUTOCOMPACT_MODEL`. Falls back to the live session model if the configured one isn't available.
3. **Tool-result stripping** — before summarizing, elides bulky non-error tool results from the middle of the compact zone (head/tail, tool calls, and errors are preserved), shrinking what the summarizer has to read.

After an auto-triggered compaction it injects a follow-up turn so the agent resumes the task instead of stalling idle.

## Configure the summarizer model

```
PI_AUTOCOMPACT_MODEL="provider/model"      # e.g. anthropic/claude-haiku-4-5
```

Everything after the first `/` is the model id (so `openrouter/meta/llama-3` works). Unset or malformed → DeepSeek V4 Flash.

## Setup

Disable pi's built-in auto-compaction so the two don't double-trigger, in `~/.pi/agent/settings.json` (or `<project>/.pi/settings.json`):

```json
{ "compaction": { "enabled": false } }
```

## Install

```
pi install @jc4649/pi-autocompact
```

Part of the [pich harness](https://github.com/JimmyC7834/pich).

## License

MIT © 2026 jc4649
