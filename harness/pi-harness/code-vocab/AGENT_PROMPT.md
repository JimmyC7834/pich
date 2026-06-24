## Codebase retrieval toolkit

You have three retrieval primitives over this codebase, in order of cost.
The atlas concept is the same artifact at three zoom levels (grand → folder
→ subfolder), produced by `make_vocab.py --mode {grand, zoom, full}`:

1. **`vocabulary.md`** is auto-attached: the **grand atlas** (whole codebase).
   It contains a `## Folder graph` block (folder-to-folder import arrows), a
   `## Folder atlas` with PageRank scores + headline symbols + drill pointers,
   and `[entry]` tags on folders / files that look like program entry points
   (`if __name__ == "__main__":`, `def main(`, `app = FastAPI()`,
   `export default function`, package.json `main`/`bin`).

2. **`python code-vocab/make_vocab.py --mode zoom --scope <folder>`** — the
   **folder/subfolder atlas**. Drills into one scope; returns docstrings,
   public symbols, class fields, and module-level constants. Costs ~1–3 k
   tokens. Use when the grand atlas points at a folder but you need more
   detail. Pass a deeper `--scope path/to/sub` for the subfolder atlas.

3. **`python code-vocab/vocab_find.py --tags tags.json [...] <query>`** —
   pinpoint and graph queries. Five modes:
   - **default** (definitions): "where is X *defined*?" — ctags.
   - **`--usages --root .`**: "who *calls / uses* X?" — ripgrep.
   - **`--imports <PATH>`**: "what does PATH import?" — graph cache.
   - **`--imported-by <PATH>`**: "who imports PATH?" — graph cache.
   - **`--neighbors <PATH>`**: both directions for PATH — graph cache.

   `<PATH>` may be a file or a folder (folder queries aggregate to that depth).
   Filters for default + `--usages`: `--scope <prefix>`, `--kind <function|class|method|...>`,
   `--regex`, `--exact`, `--limit N`.

### Routing rules

| Question shape | Tool |
|---|---|
| "Where do I start? Orient me." | Already in `vocabulary.md`; check `[entry]` tags + `## Folder graph` |
| "Tell me about folder X" | `make_vocab.py --mode zoom --scope X` |
| "Where is `Foo` defined?" | `vocab_find.py Foo` |
| "Who calls `Foo`?" | `vocab_find.py --usages Foo --root .` |
| "What does `packages/ai/src` depend on?" | `vocab_find.py --imports packages/ai/src` |
| "Who depends on `types.ts`?" | `vocab_find.py --imported-by packages/ai/src/types.ts` |
| "Architectural blast radius around X" | `vocab_find.py --neighbors X` |
| "Find symbols matching `bar*`" | `vocab_find.py 'bar*'` |
| "Symbols of kind class containing 'Manager'" | `vocab_find.py --kind class Manager` |

### Critical contract

- **`vocab_find` without `--usages` returns DEFINITIONS only.** For rename or
  reference-check tasks, you MUST run `vocab_find --usages` (or grep) to find
  the call-sites. Conflating the two will silently miss most usages.
- **Read `vocabulary.md` before searching for concepts.** Map the user's words
  to the atlas's headline symbols before picking a search term. A concept like
  "authentication" probably appears in the codebase as `AuthStorage`,
  `loginX`, `SessionManager`, etc. — surface those from the atlas first.
- **`[entry]` tag** marks files/folders the program enters from. Check them
  first when the task asks for behavior, control flow, or "where does it
  start?".
- **Rebuild the index after large changes:** `.\code-vocab\build.ps1` (or
  `./code-vocab/build.sh`). Incremental edits don't need a rebuild for most
  tasks since cached PageRank survives.
- **Dynamic references are invisible to the atlas graph.** The reference
  graph is built from static analysis (Python `ast`, tree-sitter for TS/JS,
  comment-stripped token scan elsewhere). Patterns like `getattr(obj, name)`,
  `globals()[name]`, `importlib.import_module(...)`, string-keyed dispatch
  tables — none produce graph edges. If a symbol's importance feels
  under-counted, cross-check with `vocab_find.py --usages` (ripgrep, literal).
