# pi-toolcall-guard: Live Acceptance Cases

The **pi-toolcall-guard** extension preflights all path-bearing tool calls: it normalizes safe paths in place (trimming whitespace and stripping surrounding quotes) and blocks nonexistent paths with near-match suggestions. When tools error, it enriches results with actionable `[guard]` hints (e.g., "re-read the file for fresh anchors"). Metrics are logged to a JSONL file (default: `<cwd>/.pi/guard/.pi-guard-metrics.jsonl`, alongside pi's own per-project `.pi/` state) and reported via:

```bash
cd agent/extensions/pi-toolcall-guard && npm run report
```

(If `PI_GUARD_DIR` was overridden in the session, set it to the same value when running the report command.)

## Acceptance Cases

| # | Action | Expected Guard Behavior |
|---|--------|------------------------|
| **1. Near-miss read** | Ask the agent to read a path one character off from a real file (e.g., `src/util.ts` when `src/utils.ts` exists). | Blocked with message `Did you mean: src/utils.ts?`. Agent reissues the correct path and succeeds. |
| **2. Quoted path** | Induce a read with surrounding quotes, e.g., `"src/utils.ts"` or `'src/index.ts'`. | Path is silently normalized in place (quotes removed). Tool proceeds, no guard text shown. |
| **3. Existing path** | Normal read of a real file that exists (e.g., `src/main.ts`). | Pass-through, no guard text, no block. |
| **4. Write to new file in existing dir** | Attempt to write to a file that does not exist but its parent directory does exist (e.g., write to `src/newfile.ts`). | Write is allowed; file is created. No block. |
| **5. Write into missing dir** | Attempt to write to a file whose parent directory does not exist (e.g., write to `nonexistent/file.ts`). | Blocked with message `Cannot write "...": its parent directory does not exist relative to <cwd>. Create the directory first, or fix the path.` |
| **6. ENOENT enrichment** | Force a tool error result containing `ENOENT` or `no such file or directory`. | Error result is enriched: appends `[guard]` hint: "The path doesn't exist. List the directory (ls) or search (find) to confirm the exact path before retrying." |
| **7. Stale-anchor enrichment** | Trigger a hashline stale-anchor edit error containing `stale` or `hash mismatch` or similar anchor mismatch text. | Error result is enriched with `[guard]` hint: "The file changed since you last read it. Re-read it to get fresh LINE#HASH anchors, then redo the edit against the current contents." The stale-anchor rule matches and wins over less-specific rules. |
| **8. Recovery metric** | After case 1 (a block), run `npm run report`. Confirm the `read` (or relevant tool) shows non-zero `recov%`. | Report shows `recov%` > 0 for the tool that was blocked and then recovered. Indicates the agent heeded the guard's suggestion and succeeded on retry. |
| **9. Degrade** | Set `PI_GUARD_DIR` to a path that cannot be created (e.g., a nonexistent parent with no write permission, or `PI_GUARD_DIR=/dev/null`). Start a fresh pi session and run tools. | pi starts normally (does not crash). Tool calls run unguarded (no blocks, no enrichment). Metrics file is not created. Extension silently degrades to no-op on metrics setup failure. |
