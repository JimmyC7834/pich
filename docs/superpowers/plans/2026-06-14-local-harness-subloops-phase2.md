# Local Harness — Local Sub-Loops (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let DeepSeek delegate whole sub-tasks to local-model `subagent` runs — read-only recon via `scout`, and narrow mechanical edits via a new local `worker` that escalates anything non-trivial.

**Architecture:** No new engine. A "sub-loop" is a `pi-subagents` `subagent` run on a local model (`ollama/qwen2.5-coder:14b`) with bounds set **in the agent `.md` frontmatter** (`tools`, `model`, `maxExecutionTimeMs`, `maxTokens`, `maxSubagentDepth`). Phase 2 = one new agent file, bounds on the existing `scout`, the orchestrator delegation policy, and a blocking tool-call validation up front.

**Tech Stack:** pi-subagents (`subagent` tool, already installed), Ollama (`qwen2.5-coder:14b`), agent `.md` frontmatter, the `orchestrator` skill.

**Note on testing:** This plan is config + prompts, not code. There are no unit tests to write; verification is (a) frontmatter/skill **static checks** (grep/parse assertions) and (b) **live behavior** in a real pi session. Several steps are manual gates the user runs in pi — they are marked **[MANUAL]**.

**Storage note:** `agent/agents/*.md` is git-tracked (the `!agent/agents/` exception). `skills/orchestrator/SKILL.md` is gitignored runtime config (edits are on-disk only; not committed) — consistent with prior work.

---

## File Structure

- **Create:** `agent/agents/worker.md` — local mechanical-edit worker (tracked).
- **Modify:** `agent/agents/scout.md` — add recon bounds (tracked).
- **Modify:** `skills/orchestrator/SKILL.md` — delegation policy + cleanup of dangling refs (on-disk, gitignored).

No new packages, no extension code, no vector store.

---

## Task 1: Validate 14b tool-calling in a pi subagent loop — BLOCKING GATE [MANUAL]

**Why first:** Direct Ollama testing showed `qwen2.5-coder:14b` emits a correct tool call as
**plain JSON in the message body, not in the structured `tool_calls` field.** A subagent loop
only works if pi parses the model's tool calls. If it doesn't, the `worker` (and even local
`scout` loops) won't function, and we pivot. Do this before anything else.

- [ ] **Step 1: Confirm scout is local**

Run: `grep -m1 "^model:" agent/agents/scout.md`
Expected: `model: ollama/qwen2.5-coder:14b` (set in earlier work). If not, stop and fix.

- [ ] **Step 2: [MANUAL] Run a read-only recon task through a pi subagent**

In a pi session in this workspace, launch the scout agent on a task that *requires* a tool
call and has a checkable factual answer:

```
/run scout "Count how many .md files are in agent/agents/ and list their exact names. Use ls/grep; do not guess."
```

(If `/run` is unavailable, instead prompt the main agent: "Use the scout subagent to count and
list the .md files in agent/agents/.")

- [ ] **Step 3: [MANUAL] Judge the outcome**

Watch the run output. Decide:
- **PASS** — scout actually executed tools (visible `ls`/`grep` activity) and returned the
  correct files (`code-search.md, compressor.md, research-librarian.md, scout.md,
  summarizer-fast.md, summarizer.md` — 6 files). → tool-calling works in pi; proceed to Task 2.
- **FAIL** — scout hallucinated an answer, errored parsing tool calls, or never invoked a
  tool. → pi does not parse the 14b's text tool-calls.

- [ ] **Step 4: Record the decision and branch**

Append one line to the spec's risk section noting PASS/FAIL with the date.
- On **PASS**: continue to Task 2 (build the worker).
- On **FAIL**: **stop the worker track.** Pivot options (pick with the user): (a) ship
  **recon-only** — skip Tasks 2 and the worker parts of Task 4, keep scout recon if scout
  itself passed; (b) try a local model with stronger native tool-calling for these agents;
  (c) redesign `worker` to *return a unified diff as text* that DeepSeek applies, instead of
  calling `edit`. Do not proceed to Task 2 as written until one path is chosen.

---

## Task 2: Create the local `worker` agent

**Depends on:** Task 1 PASS.

**Files:**
- Create: `agent/agents/worker.md`

- [ ] **Step 1: Write `agent/agents/worker.md`**

```markdown
---
name: worker
description: Local implementation subagent for NARROW MECHANICAL edits only; escalates anything non-trivial to the main agent
model: ollama/qwen2.5-coder:14b
tools: read, grep, find, ls, edit, write
maxExecutionTimeMs: 180000
maxTokens: 8000
maxSubagentDepth: 0
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fork
defaultProgress: true
---

You are `worker`: a LOCAL implementation subagent for narrow, mechanical edits only. You have
no shell.

You do ONLY fully-specified mechanical changes, for example:
- rename a symbol/variable/file consistently across the given scope
- add boilerplate that follows an explicit, provided pattern
- a mechanical refactor with NO design decisions (e.g. apply an explicitly described signature
  change at every call site named in the task)

You MUST NOT:
- make product, architecture, or scope decisions
- infer intent, or "improve" anything beyond the literal task
- touch any file or symbol not named in the task

If the task requires judgment, is ambiguous, is under-specified, or is not clearly mechanical:
make NO edits and reply with exactly one line:
ESCALATE: <what is missing, or why this needs the main agent>

Otherwise: read the relevant files first (never guess their contents), make the minimal
coherent edits, then reply with a one-line summary naming the files changed and what changed.
```

- [ ] **Step 2: Verify the frontmatter parses and has the bounds**

Run:
```bash
node -e "const fs=require('fs');const r=fs.readFileSync('agent/agents/worker.md','utf8');const m=r.match(/^---\n([\s\S]*?)\n---/);const f=m[1];for(const k of ['name: worker','model: ollama/qwen2.5-coder:14b','maxExecutionTimeMs: 180000','maxTokens: 8000','maxSubagentDepth: 0']){if(!f.includes(k))throw new Error('missing '+k)};if(/(^|[, ])bash([, ]|$)/m.test(f.match(/tools:.*/)[0]))throw new Error('bash must NOT be in tools');console.log('worker.md OK: bounds present, no bash')"
```
Expected: `worker.md OK: bounds present, no bash`

- [ ] **Step 3: Commit**

```bash
git add agent/agents/worker.md
git commit -m "feat(agents): local mechanical-edit worker (qwen14b, no bash, escalates)"
```

---

## Task 3: Add recon bounds to `scout`

**Files:**
- Modify: `agent/agents/scout.md`

- [ ] **Step 1: Add bounds to the frontmatter**

In `agent/agents/scout.md`, the frontmatter currently has a line `model: ollama/qwen2.5-coder:14b`.
Immediately after that line, add these two lines:
```
maxExecutionTimeMs: 180000
maxTokens: 8000
```

- [ ] **Step 2: Verify**

Run: `grep -E "^(model|maxExecutionTimeMs|maxTokens):" agent/agents/scout.md`
Expected (three lines):
```
model: ollama/qwen2.5-coder:14b
maxExecutionTimeMs: 180000
maxTokens: 8000
```

- [ ] **Step 3: Commit**

```bash
git add agent/agents/scout.md
git commit -m "feat(agents): bound scout recon (timeout + token cap)"
```

---

## Task 4: Orchestrator skill — delegation policy + cleanup

**Files:**
- Modify: `skills/orchestrator/SKILL.md` (on-disk; gitignored — no commit)

**Depends on:** Task 1 PASS (if FAIL→recon-only, omit the `worker` mentions below).

- [ ] **Step 1: Fix the "Fill knowledge gaps with" bullets**

In `skills/orchestrator/SKILL.md`, replace these three lines:
```
- **`subagent` scout** — how the codebase works, what patterns exist, which files are involved. Tools: `read`, `grep`, `find`, `ls`. Fast and cheap (Haiku).
- **`subagent` researcher** — API docs, library behavior, migration guides, external knowledge. Tools: `web_search`, `web_fetch`.
- **`subagent` worker** — isolated code changes. Tools: `read`, `write`, `edit`, `safe_bash`. Use when the change is well-specified and doesn't need back-and-forth.
```
with:
```
- **`subagent` scout** — recon: how the codebase works, where something is defined/used, mapping a feature, triaging failures, plus external/web research. Read-only; returns a findings note. Local (qwen2.5-coder:14b).
- **`subagent` worker** — NARROW MECHANICAL edits only (rename, boilerplate, mechanical refactor) that are fully specified. It makes no edits and returns `ESCALATE: <reason>` for anything non-trivial. Local (qwen2.5-coder:14b). For any non-mechanical edit, do it yourself.
```
(This drops `researcher` — `scout` now covers external/web recon — fixes the `worker`
description, and removes the stale "Haiku" mention.)

- [ ] **Step 2: Fix the parallel-mode example that names `researcher`**

In the same file, replace:
```
**Use parallel mode** (`tasks[]`) when dispatching multiple independent subagents — e.g. a scout investigating file structure while a researcher looks up API docs. Max 4 concurrent.
```
with:
```
**Use parallel mode** (`tasks[]`) when dispatching multiple independent subagents — e.g. two scouts investigating different parts of the codebase at once. Max 4 concurrent.
```

- [ ] **Step 3: Add the delegation policy**

In the "Context Hygiene" section, immediately after the paragraph that begins
`**Locate code with \`code_search\`**` (added in Phase 1), insert this block:
```
**Delegate whole sub-tasks to local sub-loops.** When a unit of work is multi-step but
low-stakes, hand it to a local subagent and get back one distilled result instead of doing
the round-trips yourself:
- **scout** ← "understand X across files", "map this feature/dir", "trace where Y is used",
  "triage these failures". Read-only; returns a findings note.
- **worker** ← a *fully-specified mechanical* edit (rename, boilerplate, mechanical refactor).
  It returns `ESCALATE: <reason>` if the task needs judgment — then you do it yourself.
Bounds (timeout, token cap, tools) live in each agent's `.md`; you may also pass `steps` on
the `subagent()` call (scout ~6, worker ~8) for a tighter loop. Do NOT delegate design
decisions, ambiguous edits, or work you can finish in one or two direct edits.
```

- [ ] **Step 4: Verify the cleanup**

Run:
```bash
grep -nE "researcher|Haiku|safe_bash" skills/orchestrator/SKILL.md; echo "exit=$?"
```
Expected: no matches (`exit=1` from grep) — i.e. `researcher`, `Haiku`, and `safe_bash` are
gone. Then:
Run: `grep -c "ESCALATE" skills/orchestrator/SKILL.md`
Expected: at least `2` (worker bullet + delegation policy).

(No commit — this file is gitignored runtime config. The full `.pi` backup covers it.)

---

## Task 5: Live + E2E validation [MANUAL]

**Depends on:** Tasks 2–4 (or, on Task 1 FAIL→recon-only, just the scout parts).

- [ ] **Step 1: [MANUAL] Recon sub-loop returns findings, no writes**

In a pi session:
```
/run scout "Map agent/extensions/pi-compress: what does the compress tool do and which files implement it? Return file:line references."
```
Expected: a findings note citing `index.ts` + `src/*.ts` with `file:line`; **no files modified**
(check `git status` after — clean working tree for that dir).

- [ ] **Step 2: [MANUAL] Worker performs a mechanical edit** *(skip if Task 1 FAIL)*

Create a throwaway file to edit, then delegate a rename:
```bash
printf 'export const oldName = 1;\nconsole.log(oldName);\n' > /tmp/wk-demo.ts
```
In pi:
```
/run worker "In /tmp/wk-demo.ts rename the identifier oldName to newName everywhere. Mechanical rename only."
```
Expected: `/tmp/wk-demo.ts` now uses `newName` in both places; worker's reply is a one-line
summary. Verify: `grep -c newName /tmp/wk-demo.ts` → `2`.

- [ ] **Step 3: [MANUAL] Worker escalates an ambiguous task** *(skip if Task 1 FAIL)*

In pi:
```
/run worker "Make the auth flow more secure."
```
Expected: reply begins `ESCALATE:` and **no files are modified** (`git status` clean).

- [ ] **Step 4: [MANUAL] E2E delegation through the orchestrator**

In a normal pi session (DeepSeek as main agent), give a natural request:
```
Where is `registerTool` used across the extensions, and how does pi-compress wire it up?
```
Expected: DeepSeek delegates recon to a `subagent` (scout) rather than reading files into its
own context; the answer comes back as a distilled note.

- [ ] **Step 5: Record results**

Note PASS/FAIL for each manual step in the spec's risk section. Phase 2 is done when recon
(Step 1) and the E2E delegation (Step 4) pass; the worker steps (2–3) pass too unless Task 1
forced the recon-only pivot.

---

## Done — Phase 2 outcome

DeepSeek can delegate whole sub-tasks to **local** subagents: read-only recon via `scout`,
and narrow mechanical edits via `worker` (which escalates anything non-trivial). All bounds
live in the agent `.md` files; no new engine, no config feature. The orchestrator skill now
routes to a real, local roster with no dangling agent references.

**Deferred:** Phase 3 (rules-based router). Optional later: a reviewer pass over local edits,
or widening `worker` scope if the 14b proves reliable.
