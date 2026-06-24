# pi-context-collapse — Live Acceptance Test

Purpose: prove the extension **loads in pi and works end-to-end** — the `tool_result`
hook collapses bulky outputs, the exempt paths (`read`/`edit`/errors/code/small) pass
through untouched, and `expand` recovers the raw bytes. The unit suite (`npm test`,
35 tests) covers internals; this covers the live agent path it cannot.

Re-run after any custom modification.

The deterministic test inputs below use `bash` + `node -e` one-liners so they are
self-contained and reproducible (no network, no pre-seeded files).

---

## 0. Setup

1. Confirm the extension is present at `agent/extensions/pi-context-collapse/` with `node_modules/`.
2. Start pi with the db/metrics in a known temp dir so you can inspect them:
   - bash: `PI_COLLAPSE_DIR=/tmp/collapse-test pi`
   - PowerShell: `$env:PI_COLLAPSE_DIR="$env:TEMP\collapse-test"; pi`
3. Create that dir first if needed.

**PASS gate for setup:** the `expand` tool is available in this session (case 1).

---

## Cases

Each case: an **action** (a tool call to make) and the **expected** observable result.
A collapsed result looks like: `⟦type:hash⟧ <type> collapsed — use the expand tool …`
followed by a compact summary.

### 1. Extension loaded (expand tool present)
- **Action:** check that a tool named `expand` exists this session.
- **Expected:** `expand` is registered. (If absent, the extension did not load.)

### 2. JSON collapse
- **Action:** `bash node -e "console.log(JSON.stringify(Array.from({length:200},(_,i)=>({name:'r'+i,stars:i}))))"`
- **Expected:** result is replaced with `⟦json:…⟧ json collapsed …` + a structural
  summary (`array[200] of object{name,stars}` + a `sample[0]=…`). Output is **shorter**
  than the raw 200-element array. Capture the handle.

### 3. Log collapse (dedupe)
- **Action:** `bash node -e "for(let i=0;i<40;i++)console.log('INFO 2026-06-17T00:00 worker tick processing queued item')"`
- **Expected:** `⟦log:…⟧` with the repeated line shown once and a `(×40)` count.

### 4. Paths collapse (dir clustering)
- **Action:** `bash node -e "for(let i=0;i<50;i++)console.log('src/'+(i%3===0?'core':i%3===1?'tools':'ui')+'/file'+i+'.ts')"`
- **Expected:** `⟦paths:…⟧` reporting `50 paths in N dirs` clustered by top dir
  (`src/core (…)`, `src/tools (…)`, `src/ui (…)`).

### 5. expand round-trip (byte-exact recovery)
- **Action:** call `expand` with the handle from case 2.
- **Expected:** returns the **exact** original JSON string (byte-for-byte), no summary.

### 6. expand paging (large original)
- **Action:** `bash node -e "process.stdout.write('A'.repeat(40000))"` (collapses or passes
  through depending on classification — if it does NOT collapse, skip to noting that;
  a 40k single-line non-JSON is not classifiable, so instead use a large JSON:)
  `bash node -e "console.log(JSON.stringify(Array.from({length:4000},(_,i)=>({i,pad:'xxxxxxxxxx'}))))"`
  → collapse it, then `expand` the handle with `offset: 0`, then again with the
  `offset` named in the continuation hint.
- **Expected:** first page ends with `[Showing chars 0-16000 of … Use offset=16000 to continue.]`;
  paging through and concatenating the slices reconstructs the full raw.

### 6 — exemptions (the safety-critical cases) ───────────────────────────

### 7. `read` is NOT collapsed
- **Action:** `read` any source file (e.g. `agent/extensions/pi-context-collapse/src/router.ts`).
- **Expected:** normal read output (hashline `LINE#HH:` if hashline is also active, else
  plain). **No `⟦…⟧` handle.** This is the byte-exactness guarantee for the edit loop.

### 8. `edit` is NOT collapsed
- **Action:** make any small `edit` to a scratch file.
- **Expected:** the edit result (anchors/diff) passes through. **No `⟦…⟧` handle.**

### 9. Error results are NOT collapsed
- **Action:** `bash node -e "for(let i=0;i<40;i++)console.error('repeated error line '+i); process.exit(1)"`
  (a failing command with bulky stderr).
- **Expected:** the error result passes through unchanged. **No `⟦…⟧` handle** (errors
  are never collapsed, even when bulky).

### 10. Small output is NOT collapsed
- **Action:** `bash echo "hello world"`
- **Expected:** plain `hello world`, no handle (below the 200-token floor).

### 11. Code / grep-with-line-numbers is NOT collapsed
- **Action:** `bash grep -n "function" agent/extensions/pi-context-collapse/src/hashline*.ts` —
  or, if no match, `bash cat agent/extensions/pi-context-collapse/src/router.ts`.
- **Expected:** exact `file:line:content` (or raw code) preserved. **No `⟦…⟧` handle** —
  the `:` form is excluded from `paths`, and code is not JSON/log-shaped.

### 12. Metrics logged (the tuning data)
- **Action:** inspect `$PI_COLLAPSE_DIR/.pi-collapse-metrics.jsonl`.
- **Expected:** one `{"kind":"collapse",…}` line per collapse (cases 2–4, 6) and one
  `{"kind":"expand",…}` per expand (cases 5–6), each with `ts`. This is the
  **expand-rate** data for tuning which content-types are worth collapsing.

---

## Result rubric

- **Smoke pass** (minimum to call it working): cases **1, 2, 5** pass.
- **Safety-critical** (must pass — these protect correctness): **7, 9, 11** (and 8, 10).
  A collapse appearing on any of these is a HIGH-severity failure — it means a path that
  must stay byte-exact got mangled.
- **Full pass:** all of 1–12.
- Record any case where `expand` did NOT return the byte-exact original (case 5/6) — that
  breaks the reversibility guarantee and is HIGH severity.

## Cleanup
Delete the scratch edit file and `$PI_COLLAPSE_DIR` (`.pi-collapse.db*`, `.pi-collapse-metrics.jsonl`).
