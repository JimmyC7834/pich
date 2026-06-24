# @jc4649/pi-harness

The 1-click umbrella for the **pich** harness — a curated set of [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extensions, wired together.

Installing this one package pulls in all 12 `@jc4649/*` extensions, bundles the personal glue (memory, ponytail persona, design principles, startup dashboard, code-vocab tooling), and ships an `init` bin that wires everything into `~/.pi` non-destructively.

## 1-click install

```
npx @jc4649/pi-harness init
```

This adds every harness package to `~/.pi/agent/settings.json` (as `npm:` sources) without removing anything you already configured, and disables pi's built-in compaction so `@jc4649/pi-autocompact` can own it (only if you haven't set a compaction policy yourself). Launch pi afterwards — it installs the npm packages on first run.

## What's included

| Package | Role |
|---|---|
| `@jc4649/pi-toolcall-guard` | Preflight path/content guard + destructive-bash guard |
| `@jc4649/pi-context-collapse` | Write-once collapse of bulky tool output |
| `@jc4649/pi-capability-index` | Skill/tool discovery, activation, loadouts |
| `@jc4649/pi-ralph` | Kanban task board for multi-step work |
| `@jc4649/pi-semble` | Semantic repo search |
| `@jc4649/pi-usage-recorder` | Token & context telemetry |
| `@jc4649/filechanges` | Live diff review of edits |
| `@jc4649/telegram-remote` | Drive a session from a Telegram bot |
| `@jc4649/notify` | Native terminal notifications |
| `@jc4649/pi-autocompact` | Proactive, configurable-model compaction |
| `@jc4649/pi-web-tools` | Web search / fetch / extraction |
| `@jc4649/pi-hashline-edit` | Hash-anchored read/edit tools |
| **glue** (bundled here) | memory, ponytail-lite, design-principles, startup-logo, sysprompt-to-user, code-vocab-wire |

## À la carte

Don't want the whole set? Install any one:

```
pi install @jc4649/pi-ralph
```

## License

MIT © 2026 jc4649
