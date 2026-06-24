# pi-hashline-edit — Live Acceptance Test

Purpose: prove the extension **loads in pi and overrides the real `read`/`edit` tools**,
exercising the headline guarantees end-to-end. The unit suite (`npm test`) covers internals;
this covers the live agent path that unit tests cannot.

Re-run this after any custom modification.

---

## 0. Setup

1. Confirm the extension is present: `agent/extensions/pi-hashline-edit/` with `node_modules/`.
2. Start pi with the debug banner on:
   - bash: `PI_HASHLINE_DEBUG=1 pi`
   - PowerShell: `$env:PI_HASHLINE_DEBUG=1; pi`
3. Create the fixture file `scratch/hashline-fixture.ts` with exactly this content (LF):

```ts
export function greet(name: string): string {
  return `Hello, ${name}`;
}

export function add(a: number, b: number): number {
  return a + b;
}

const TODO = "replace me";
```

**PASS gate for setup:** banner "Hashline Edit mode active" shows at session start.

---

## Cases

Each case: an **action** to ask the agent (or call the tool) to do, and the **expected**
observable result. A case passes only if the expected markers appear.

### 1. Tagged read output (the override is live)
- **Action:** `read scratch/hashline-fixture.ts`
- **Expected:** every returned line is prefixed `N#HH:` where `HH` is two chars from
  `ZPMQVRWSNKTXJBYH`, with the `#` columns aligned. (If you see plain numbered lines with
  no hash, the built-in read is still active — the extension did not load.)

### 2. Hash-anchored single-line replace
- **Action:** copy the anchor for the `const TODO = "replace me";` line (e.g. `10#XX`) and
  `replace` it with `const TODO = "done";`.
- **Expected:** success; result contains a `--- Anchors A-B ---` block with fresh
  `LINE#HASH` lines for the changed region. File on disk now reads `const TODO = "done";`.

### 3. Stale-anchor rejection
- **Action:** using the **anchor from step 1** (now stale, since step 2 changed the file),
  attempt another `replace` on the `TODO` line.
- **Expected:** error beginning `[E_STALE_ANCHOR]`, a `Stale refs: ...` line, and one or
  more `>>> LINE#HASH:content` retry lines showing current hashes. **File unchanged.**

### 4. Chained edit from returned anchors (no re-read)
- **Action:** take a fresh anchor from the `--- Anchors ---` block returned in step 2 and
  use it directly to `replace` a nearby line.
- **Expected:** success without an intervening `read`. New `--- Anchors ---` block returned.

### 5. Range replace
- **Action:** `replace` the `add` function body span (`pos` = its `export function add`
  line, `end` = its closing `}`) with a 3-line replacement.
- **Expected:** success; the three original lines collapse/expand to the new content; no
  boundary-duplication warning if you did not repeat a surrounding line.

### 6. `replace_text` uniqueness
- **6a unique:** `replace_text` `oldText: "Hello, "` → `newText: "Hi, "`. **Expected:** success.
- **6b multi:** `replace_text` `oldText: "number"` (appears multiple times) → anything.
  **Expected:** `[E_MULTI_MATCH]`. **File unchanged.**
- **6c absent:** `replace_text` `oldText: "nonexistent-zzz"`. **Expected:** `[E_NO_MATCH]`.

### 7. Strict patch content
- **Action:** `replace` a line but put a display prefix in `lines`, e.g.
  `lines: ["10#XX:const TODO = \"x\";"]`.
- **Expected:** `[E_INVALID_PATCH]` — runtime refuses; it does **not** silently strip the prefix.

### 8. Append / prepend boundaries
- **8a EOF append:** `append` with `pos` omitted, `lines: ["", "export const VERSION = 1;"]`.
  **Expected:** lines added at end of file.
- **8b BOF prepend:** `prepend` with `pos` omitted, `lines: ["// @generated", ""]`.
  **Expected:** lines added at start of file.

### 9. Native-dialect normalization (back-compat)
- **Action:** call `edit` with the **built-in shape** — top-level
  `{ "path": ..., "oldText": "done", "newText": "DONE" }` (no `edits` array, no `op`).
- **Expected:** treated as `replace_text` and applied (success), proving
  `normalizeEditRequest` converges the native contract instead of erroring.

### 10. Conflict + safety guards
- **10a conflict:** one `edit` call with two `replace` ops targeting overlapping/adjacent
  lines. **Expected:** `[E_EDIT_CONFLICT]`, nothing written.
- **10b would-empty:** `replace` `pos`=line 1 `end`=last line with `lines: []`.
  **Expected:** `[E_WOULD_EMPTY]`, file intact.

### 11. CRLF preservation (atomic write)
- **Action:** create `scratch/crlf-fixture.txt` with CRLF endings, `read` then `replace`
  one line.
- **Expected:** edit succeeds; re-open the file and confirm endings are still CRLF
  (the engine normalizes to LF internally but restores the original ending on write).

---

## Result rubric

- **Smoke pass** (minimum to call the override working): cases **1, 2, 3** pass.
- **Full pass:** all cases 1–11 pass.
- Record any case where the *file on disk* diverged from the expected state — those are the
  high-severity failures (the protocol's whole point is never editing the wrong bytes).

## Cleanup
Delete `scratch/hashline-fixture.ts` and `scratch/crlf-fixture.txt`.
