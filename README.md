# pich

A composable **harness** for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent): twelve `@jc4649/*` extensions you can install à la carte, plus a single umbrella (`@jc4649/pi-harness`) that wires them all up in one command.

Like pi itself — which is just four packages composed together — pich is many small packages plus an umbrella. Use one, use all, or build your own loadout.

## Design

The harness is organized as **four layers** — three about an agent's context window, one about how it writes code — plus a handful of quality-of-life extras. Together they keep the model well-fed, lean, disciplined, and cheap to drive.

> **1 · Get the right information in** — so the model works from facts, not guesses.
> **2 · Keep the context window lean** — so those facts cost as few tokens as possible.
> **3 · Stay out of the way** — minimal, opt-in workflow tools instead of a heavy framework.
> **4 · Code with discipline and safety** — guardrails and coding-specialized behavior so changes stay correct and minimal.
> **+ Quality-of-life** — small ergonomics: memory, notifications, dashboard.

### Layer 1 — Information fetching

Pull exactly the right code, docs, web content, and capabilities into context on demand — no blind grepping, no stale dumps.

| Package | Role |
|---|---|
| [`pi-semble`](packages/pi-semble) | Semantic + lexical search and indexing over this repo's code **and** the local doc library (`repo_search` / `kb_search` / `find_related`). Quick, token-less pinpoint information retrieval. |
| [`pi-web-tools`](packages/pi-web-tools) | Web search, URL fetch, GitHub clone, PDF/YouTube/video extraction. |
| [`pi-capability-index`](packages/pi-capability-index) | Skill/tool registry: discover, activate, and load only the capabilities a task needs. |
| `code-vocab` *(umbrella glue)* | ctags symbol atlas; redirects naive code discovery to structured lookups. |

### Layer 2 — Token & context-window optimization

Every token earned in Layer 1 is spent carefully here: collapse the bulky, compact early, and measure the spend.

| Package | Role |
|---|---|
| [`pi-context-collapse`](packages/pi-context-collapse) | Write-once collapse of bulky tool output to a short deterministic summary; original is recoverable with `expand`. |
| [`pi-autocompact`](packages/pi-autocompact) | Proactive compaction (50% threshold) using a cheap, configurable summarizer + middle-of-zone tool-result stripping. |
| [`pi-usage-recorder`](packages/pi-usage-recorder) | Per-turn token / cache / cost / context-fill telemetry — the measurement that makes the rest tunable. |

*(Cross-cutting: `pi-capability-index` also caps the always-visible skills block, trimming the prompt prefix it contributes.)*

### Layer 3 — Lightweight minimal workflow options

Small, opt-in tools — not a framework. Each is one focused capability you can ignore until you want it.

| Package | Role |
|---|---|
| [`pi-ralph`](packages/pi-ralph) | Kanban task board + iterative loop for structured multi-step work. |
| [`filechanges`](packages/filechanges) | Live diff review of every edit, with accept / revert (fork of pi-config). |
| [`telegram-remote`](packages/telegram-remote) | Drive a session from a Telegram bot — set a token and go. |

### Layer 4 — Coding guardrails & specialization

Make pi a *coding* agent specifically: stop dangerous or sloppy actions before they land, and steer the model toward correct, minimal changes.

| Package | Role |
|---|---|
| [`pi-toolcall-guard`](packages/pi-toolcall-guard) | Preflight path/content guard, reminder injection, and destructive-bash guard — blocks workspace escapes and catastrophic shell commands, redirects raw `cat`/`grep`/`sed` to dedicated tools. Real time streaming level prompt injection and abort available for advanced custom guardrails. |
| [`pi-hashline-edit`](packages/pi-hashline-edit) | Hash-anchored `read`/`edit`: every edit cites a `LINE#HASH`, so stale or misaligned edits are rejected instead of silently corrupting a file. |
| `ponytail-lite` *(umbrella glue)* | Lazy senior-dev persona (`off`/`lite`/`full`/`ultra`) — enforces the stdlib-first "ladder", bans speculative abstractions, mandates one self-check per non-trivial change. |
| `zz-design-principles` *(umbrella glue)* | Injects a software-design manifesto + surgical-changes discipline (loads last so other injectors compose first). |

### Quality-of-life extras

Small ergonomics that make the harness pleasant to live in. The single-file ones ship inside the umbrella; `notify` is its own package.

| Feature | Role |
|---|---|
| [`notify`](packages/notify) | Native terminal notification (OSC 777/99 / Windows Toast) when the agent asks a question or finishes a turn. |
| `memory` *(umbrella glue)* | Always-on long-term memory — hand-editable one-liner facts injected each turn. |
| `startup-logo` *(umbrella glue)* | Custom startup dashboard: ASCII logo + session/model/branch info. |
| `sysprompt-to-user` *(umbrella glue)* | Surfaces system-prompt content to the user for transparency. |

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

The 12 packages map onto the three layers above; the umbrella also bundles the single-file glue (`code-vocab`, `memory`, `ponytail-lite`, `zz-design-principles`, `startup-logo`, `sysprompt-to-user`) and the `init` bin.

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

This harness builds on the work of others:

- **`pi-web-tools`** — fork of [pi-web-access](https://github.com/nicobailon/pi-web-access) by Nico Bailon (MIT).
- **`pi-hashline-edit`** — inspired by [RimuruW's pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) (MIT).
- **`filechanges`** — fork of [pi-config](https://github.com/amosblomqvist/pi-config) by amosblomqvist (MIT).
- **`pi-semble`** — search powered by [semble](https://github.com/MinishLab/semble) by MinishLab.

Forks preserve the original copyright lines in their `LICENSE`; see each package's README for details.

## License

MIT © 2026 jc4649
