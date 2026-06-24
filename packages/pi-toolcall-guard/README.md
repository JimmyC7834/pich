# @jc4649/pi-toolcall-guard

A deterministic tool-call guard for the [pi](https://github.com/earendil-works/pi) coding agent. Intercepts every tool call (`tool_call` hook) and applies layered protection, then enriches errors on the way back.

## Layers

1. **Destructive-bash guard** — analyzes `bash` commands for risk (rm/dd/format, sudo, force-push, disk/infra teardown, pipe-to-shell). In an interactive session, prompts the user to confirm high-risk commands (`ctx.ui.confirm`); in a headless subagent, hard-blocks catastrophic operations.
2. **Nudge** — redirects `bash` cat/grep/sed/etc. to the dedicated `read`/`grep` tools when they exist.
3. **Path preflight** — normalizes file paths in place, or blocks paths escaping the workspace.
4. **Repair + schema** — fixes common malformed inputs (null optionals, unknown params) and validates against the tool schema before the call runs.
5. **Content rules** — loads rule files from `<cwd>/.pi/guard-rules/` and blocks/reminds based on content patterns; also watches the output stream in real time for prose-rule violations.

On the way back it **enriches error results** (e.g. SQLite `UNIQUE constraint` → actionable guidance).

## Configuration
- `PI_GUARD_DIR` — artifact dir (default `<cwd>/.pi/guard`).
- `PI_GUARD_STREAM=0` — disable real-time stream watching.
- `--bash-guard-auto-allow` — allow high-risk bash when no UI is available (non-interactive).

## Install
```
pi install @jc4649/pi-toolcall-guard
```

MIT
