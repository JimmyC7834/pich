# Harness Distribution Restructure — Implementation Plan

> **For agentic workers:** plan-only until Phase 0 is green-lit. Steps use checkbox (`- [ ]`) syntax. Each phase is independently shippable and ends with a verification.

**Goal:** Turn the harness into one monorepo that publishes N composable `@jc4649/*` npm packages **and** a single umbrella (`@jc4649/pi-harness`) people can 1-click install — mirroring pi's own 4-package structure.

**Architecture:** One repo, many packages (lockstep versioned). Reusable extensions publish à-la-carte (the "freedom"); the umbrella depends on them, bundles the personal glue + shared skills/prompts, and ships a `pi` manifest + `init` bin (the 1-click). The VS Code app keeps its own `.vsix` path.

**Tech stack:** Node 24, npm workspaces, pi extension API (`pi.extensions` manifest, jiti `.ts` loading), `node:sqlite`, MIT.

## Global Constraints
- **Lockstep versioning** — one version for the whole repo; a `publish-all` script. No changesets/turbo until external users need granular pins.
- **Published source only** — pi loads `.ts` via jiti; ship source, no `dist/` build. Every published package keeps a `files[]` whitelist (verified by `npm pack --dry-run`: no tests/tsconfig/`.pi-` data).
- **Pi-provided peers** (`@earendil-works/*`) stay `peerDependencies`, never `dependencies`.
- **Fork licensing** — `pi-web-tools` (Nico Bailon) and `pi-hashline-edit` (RimuruW) are MIT forks: preserve the original copyright line in `LICENSE`, add credit in `README`, publish under the distinct `@jc4649/*` name.
- **No secret ever ships** — telegram token lives in `~/.pi/telegram-remote.json`, provided post-install.

---

## Phase 0 — Decouple source repo from `~/.pi` runtime  *(blocks everything; biggest move)*

Today the repo root **is** `~/.pi` (caches, sessions, `auth.json`, the locked `collapse` stub). It is unpublishable as-is. Carve a clean source repo; `init` (Phase 5) reinstalls it into `~/.pi`.

**Files:** new repo root `pich/` (clean); everything currently tracked moves in; runtime dirs stay behind in `~/.pi`.

- [ ] **0.1** Enumerate tracked-vs-runtime: `git ls-files` = the source set; `capabilities/ cache/ kb/ skills/ .pi/ agent/sessions/ agent/auth.json agent/*.json` = runtime (stays in `~/.pi`, never in the source repo).
- [ ] **0.2** Create `pich/` (new git repo or `git mv` into a `pich/` subtree). Move only the tracked source set: `agent/extensions/**`, `docs/**`, `README.md`, `.gitignore`, `scripts/**`.
- [ ] **0.3** Decide skills/prompts: authored skills you want to ship move into `harness/pi-harness/skills/` (Phase 4); the rest stay runtime.
- [ ] **0.4 Verify:** in a scratch `~/.pi-test` HOME, `pi` still loads extensions from the *installed* location (not the source repo). Source repo has zero runtime/secret files: `git ls-files | grep -E 'auth|sessions|\.db|cache/' ` → empty.

---

## Phase 1 — Reorganize into `packages/` · `harness/` · `apps/`

**Target tree:**
```
pich/
  packages/   pi-toolcall-guard pi-context-collapse pi-capability-index pi-ralph
              pi-semble pi-usage-recorder filechanges telegram-remote notify
              pi-autocompact pi-web-tools pi-hashline-edit       (12 published)
  harness/pi-harness/
              package.json  pi-manifest  extensions/(glue)  skills/ prompts/  bin/init.js
  apps/pi-vscode/                                            (.vsix path)
```

- [ ] **1.1** `git mv agent/extensions/<pkg> packages/<pkg>` for the 11 current package dirs.
- [ ] **1.2** `git mv agent/extensions/pi-vscode apps/pi-vscode` (bridge already inside it).
- [ ] **1.3** Move the 6 glue loose files into `harness/pi-harness/extensions/`: `code-vocab-wire.ts memory.ts ponytail-lite.ts zz-design-principles.ts sysprompt-to-user.ts startup-logo.ts`.
- [ ] **1.4** Fold `capability-browser.ts` into `packages/pi-capability-index/` and add it as a 2nd `pi.extensions` entry there; drop its sibling-relative import (use its own `node:sqlite` opener).
- [ ] **1.5** Replace the single `agent/extensions/package.json` workspace with a root `pich/package.json` workspace: `"workspaces": ["packages/*", "harness/pi-harness"]` (apps/pi-vscode keeps its own install).
- [ ] **1.6 Verify:** `npm install` at root; `npm -ws run test` (or per-package vitest) all green; `npx tsc --noEmit` per package clean.

---

## Phase 2 — `deepseek-compact` → `@jc4649/pi-autocompact` (configurable compactor model)

**Files:** `packages/pi-autocompact/` (renamed from `harness/.../deepseek-compact.ts`), split into `index.ts` + `src/`.

- [ ] **2.1 Test first:** add `test/model.test.ts` asserting the compaction model resolves from `PI_AUTOCOMPACT_MODEL` env (or a settings field), falling back to the session model.
- [ ] **2.2** Run it → FAIL (function not defined).
- [ ] **2.3** Implement `resolveCompactModel(env, sessionModel): string` and thread it into the compaction call; keep the existing auto-compact + strip rules.
- [ ] **2.4** Run → PASS.
- [ ] **2.5** Package metadata: `@jc4649/pi-autocompact`, MIT LICENSE, README (auto-compact + config + stripping), `files[]`, `pi.extensions`.
- [ ] **2.6 Verify:** `npm pack --dry-run` clean; describe the rename in the README's "formerly deepseek-compact" note. **Commit.**

---

## Phase 3 — Fork licensing for `pi-web-tools` + `pi-hashline-edit`

- [ ] **3.1** `packages/pi-web-tools/LICENSE`: keep `Copyright (c) … Nico Bailon` line; append `Copyright (c) 2026 jc4649`.
- [ ] **3.2** `packages/pi-web-tools/README.md`: "Fork of `pi-web-access` by Nico Bailon — slimmed (node-html-markdown swap −8.7 MB, magic-byte image sniff, dropped file-type). MIT." Set `name`=`@jc4649/pi-web-tools`, `author`, `repository`, `files[]`.
- [ ] **3.3** Same for `pi-hashline-edit`: preserve RimuruW's copyright; README credits "inspired by RimuruW's pi-hashline-edit; deps diff, xxhashjs"; `name`=`@jc4649/pi-hashline-edit`.
- [ ] **3.4 Verify:** `npm pack --dry-run` ships `LICENSE` with both copyright lines. **Commit.** *(Optional: open upstream PRs for the slimming.)*

---

## Phase 4 — Build the `@jc4649/pi-harness` umbrella

**Files:** `harness/pi-harness/package.json`, `harness/pi-harness/pi-manifest` (the `pi` field), `extensions/` (the 6 glue + telegram? no—telegram is a package now), `skills/`, `prompts/`.

- [ ] **4.1** `package.json`: `name @jc4649/pi-harness`, `dependencies` on all 12 `@jc4649/*` packages (lockstep version), `files[]`, MIT.
- [ ] **4.2** `pi` manifest: `extensions: [` the 6 bundled glue `.ts` + a re-export entry for each dep package, OR rely on each dep's own manifest `]`; `skills: ["./skills"]`, `prompts: ["./prompts"]`. *(Confirm during impl whether pi auto-loads a dependency package's manifest, or the umbrella must list each — determines whether 4.2 lists 12 entries or 0.)*
- [ ] **4.3** Move shared authored skills/prompts here from Phase 0.3.
- [ ] **4.4 Verify:** in scratch HOME, `"packages": ["file:harness/pi-harness"]` in settings → pi loads all 18 extensions + skills. Inventory the loaded set matches the table.

---

## Phase 5 — `init` bootstrap bin (closes pi's settings-install gap)

**Files:** `harness/pi-harness/bin/init.js` (+ `"bin": {"pi-harness": "./bin/init.js"}`).

- [ ] **5.1 Test:** `test/init.test.ts` — running init against a temp HOME writes a merged `settings.json` (does not clobber existing keys) and symlinks/installs the package.
- [ ] **5.2** FAIL → implement: merge a recommended `settings.json` (provider/model/loadout/theme — as *suggestions*, non-destructive), optionally install the `.vsix` if `code` is on PATH, print next steps. → PASS.
- [ ] **5.3 Verify:** `npx @jc4649/pi-harness init` on a fresh HOME yields a working pi with the harness loaded. **Commit.**

---

## Phase 6 — Lockstep publish workflow

**Files:** root `package.json` scripts, `.github/workflows/publish.yml` (optional).

- [ ] **6.1** Root scripts: `version:all` (`npm version <x> -ws --include-workspace-root`), `publish:all` (`npm publish -ws --access public`).
- [ ] **6.2** Dry-run: `npm publish -ws --dry-run --access public` → every `@jc4649/*` packs clean, no leaks.
- [ ] **6.3 Verify:** versions match across all packages; **commit** the workflow.

---

## Phase 7 — Verify the 1-click on a clean profile

- [ ] **7.1** Fresh `HOME`/`~/.pi`; `npx @jc4649/pi-harness init`.
- [ ] **7.2** Launch pi → confirm all 18 extensions load, skills present, a sample tool (capability_search / ralph_add) works.
- [ ] **7.3** À-la-carte check: separate scratch HOME, `pi install @jc4649/pi-ralph` alone → only ralph loads. (Proves the "freedom" half.)
- [ ] **7.4** Document install in root `README.md` (1-click + à-la-carte).

---

## Open questions to resolve during impl
1. **4.2** — does pi recursively load a dependency package's `pi` manifest, or must the umbrella enumerate every entry? Decides umbrella manifest shape.
2. **Phase 0** — new git history (fresh repo) vs `git filter-repo` to preserve this repo's history into `pich/`. Preserving history is nicer but heavier.
3. Skills/prompts: which authored ones are harness-shipped vs personal-runtime-only.
