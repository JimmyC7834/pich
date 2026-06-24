# pich

A composable **harness** for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent): twelve `@jc4649/*` extensions you can install à la carte, plus a single umbrella (`@jc4649/pi-harness`) that wires them all up in one command.

Like pi itself — which is just four packages composed together — pich is many small packages plus an umbrella. Use one, use all, or build your own loadout.

## Install

**Everything (1-click):**

```
npx @jc4649/pi-harness init
```

Adds all packages to `~/.pi/agent/settings.json` non-destructively, then launch pi.

**À la carte:**

```
pi install @jc4649/pi-ralph
pi install @jc4649/pi-web-tools
```

## Layout

```
packages/      12 published @jc4649/* extensions
harness/       @jc4649/pi-harness umbrella — glue + code-vocab + init bin
apps/          pi-vscode IDE companion (.vsix, installed separately)
docs/          plans & specs
```

### Packages

| Package | What it does |
|---|---|
| [`pi-toolcall-guard`](packages/pi-toolcall-guard) | Preflight path/content guard + destructive-bash guard |
| [`pi-context-collapse`](packages/pi-context-collapse) | Deterministic write-once collapse of bulky tool output |
| [`pi-capability-index`](packages/pi-capability-index) | Skill/tool discovery, activation, loadouts (+ capability browser) |
| [`pi-ralph`](packages/pi-ralph) | Kanban task board for structured multi-step work |
| [`pi-semble`](packages/pi-semble) | Semantic repo search |
| [`pi-usage-recorder`](packages/pi-usage-recorder) | Token & context telemetry |
| [`filechanges`](packages/filechanges) | Live diff review of every edit |
| [`telegram-remote`](packages/telegram-remote) | Drive a session from a Telegram bot |
| [`notify`](packages/notify) | Native terminal notifications |
| [`pi-autocompact`](packages/pi-autocompact) | Proactive, configurable-model compaction (formerly deepseek-compact) |
| [`pi-web-tools`](packages/pi-web-tools) | Web search / fetch / extraction (fork of pi-web-access) |
| [`pi-hashline-edit`](packages/pi-hashline-edit) | Hash-anchored read/edit tools (fork) |

## Development

Lockstep-versioned npm workspace.

```
npm install        # install all packages
npm test           # run every package's tests
npm run check      # typecheck every package
npm run version:all 0.2.0
npm run publish:all
```

## Credits

`pi-web-tools` is a fork of [pi-web-access](https://github.com/nicobailon/pi-web-access) by Nico Bailon. `pi-hashline-edit` is inspired by [RimuruW's pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit). Both MIT; original copyright lines preserved.

## License

MIT © 2026 jc4649
