# code-vocab

Python stdlib only for the core; tree-sitter is an optional
dependency that upgrades TypeScript/JavaScript handling and unlocks a
generic multi-language AST tier (Go, …). No
embedding model, no API calls, no GPU, no daemon. Works offline.

## Supported languages

| Language | Tier | Backend |
|---|---|---|
| Python | AST | stdlib `ast` (always available) |
| TS / JS / TSX / JSX | AST | `tree-sitter` + `tree-sitter-typescript` (optional) |
| Go (and any `LangSpec` in `langspec.py`) | AST | `tree-sitter-language-pack` (optional) |
| Everything else | lexical | comment/string-stripped token scan (always available) |

Each tier degrades gracefully: a language whose grammar isn't installed falls
back to the lexical scan. Add a language by appending one `LangSpec` to
`langspec.py` — no parser changes (see that file's header).

## What's in the box

| File | Role |
|---|---|
| `make_vocab.py` | Builds `vocabulary.md` (atlas / full / section modes). Stdlib only. |
| `langspec.py` | Declarative per-language config for the generic tree-sitter AST tier. |
| `vocab_find.py` | CLI symbol lookup over `tags.json` (definitions + `--usages`). |
| `build.ps1` / `build.sh` | Wrappers: run `ctags` then `make_vocab.py`. |
| `bin/ctags.exe` | Portable Universal Ctags 6.1.0 (x64, Windows). No install needed. |
| `AGENT_PROMPT.md` | The short contract to paste into the agent's system prompt. |
| `gitignore.recommended` | Patterns to add to the host repo's `.gitignore`. |

Generated artifacts (at the host repo root): `tags.json`, `tags.json.cache`,
`vocabulary.md`.

## Prerequisites

- **Universal Ctags ≥ 6.x** — bundled as `bin/ctags.exe` (Windows x64). On
  other platforms install via `brew install universal-ctags` /
  `apt install universal-ctags` and pass `-Ctags`/`$CTAGS`.
- **Python ≥ 3.10** (stdlib only).
- **ripgrep** optional for `vocab_find --usages` (pure-Python fallback exists).
- ***Optional:*** `pip install tree-sitter tree-sitter-typescript` (~3 MB total) for
  full AST extraction on TS/JS/TSX/JSX files. Without tree-sitter,
  those languages fall back to a comment/string-stripped lexical scan
  — working but lossier.
- ***Optional:*** `pip install tree-sitter-language-pack` (~30–40 MB; bundles
  ~165 grammars) to enable the generic AST tier for every language registered
  in `langspec.py` (Go today). Without it, those files use the lexical scan.
## Build

```powershell
# atlas (default, ≤ ~2k tokens), against the current repo:
.\code-vocab\build.ps1 -Root . -Mode atlas

# full brief or a single folder:
.\code-vocab\build.ps1 -Root . -Mode full
.\code-vocab\build.ps1 -Root . -Mode section -Scope agent/extensions
```

```bash
./code-vocab/build.sh atlas         # mode, atlas-budget, tokens-per-file
ROOT=. SCOPE=agent ./code-vocab/build.sh section
```

## The three-tier flow

1. **`vocabulary.md`** (auto-attached) — folder atlas ranked by PageRank.
2. **`make_vocab.py --mode section --scope <folder>`** — drill into one folder.
3. **`vocab_find.py <query>`** — exact symbol lookup (`--usages` for call-sites).

## Adding a language to the AST tier (hand-off)

The generic tier is **declarative**: a new language = one `LangSpec` appended to
`langspec.py`. No changes to `make_vocab.py`, the parser, or the graph engine —
`build_graph_v2` discovers specs from `LANG_SPECS` and dispatches automatically.
Files whose grammar isn't installed fall back to the lexical scan.

**Steps**

1. **Find the grammar key** in `tree-sitter-language-pack` (usually the lang
   name, e.g. `"go"`, `"rust"`, `"java"`).
2. **Discover the node-type names** by parsing a sample file and printing types:
   ```python
   from tree_sitter_language_pack import get_parser
   root = get_parser("rust").parse(open("sample.rs","rb").read()).root_node
   for n in root.named_children: print(n.type)        # top-level decl/import nodes
   ```
   Cross-check against the grammar's `node-types.json` or its `tags.scm`.
3. **Append a `LangSpec`** to `langspec.py` and `register(...)` it. Fields:

   | Field | What it is |
   |---|---|
   | `name`, `grammar`, `exts` | label, language-pack key, file extensions |
   | `def_nodes` | `{node.type: "class"\|"function"\|"constant"}` for top-level decls; the parser reads each node's `child_by_field_name("name")` |
   | `member_node` | node type for `obj.attr` access (TS `member_expression`, Go `selector_expression`) |
   | `import_node` | top-level node type that wraps imports |
   | `extract_imports(node)` | → `list[(local_name, specifier, imported_name)]`; `imported_name=""` for whole-module imports |
   | `resolve_import(specifier, cur_rel, root)` | → repo-relative POSIX path of the target file, or `None` for stdlib/external |
   | `is_exported(name)` | is the name visible cross-file? (Go: capitalized; Rust: `pub`; Java/C#: `public`) |
   | `entry_patterns` | regexes over source that flag a program entry point |

4. **Add a test** `tests/test_<lang>_graph.py` mirroring `test_generic_graph.py`:
   an exported define + a real import → edge; an unexported name → no define;
   skip cleanly when the grammar isn't installed (`mv._get_parser("<g>") is None`).

**Verify**
```bash
cd code-vocab && python -m pytest tests/test_<lang>_graph.py -v
```

**Gotchas (budget for these)**

- **`resolve_import` is the hard part.** Map the language's import namespace to a
  repo file (Go import paths, Java/Kotlin packages, C# namespaces). When
  intra-repo resolution fails, return `None` and accept "no edge" — never guess
  (there is deliberately no single-global-definer fallback).
- **Visibility varies.** Encode it in `is_exported`. If it needs the AST node
  (not just the name — e.g. a `pub` modifier), widen the callback to
  `(name, node)` and thread the node through `_generic_decl_names`.
- **Grouped declarations** (Go `const (...)`, Rust `use a::{b, c}`) need
  `extract_imports` / `_generic_decl_names` to descend into spec lists.
- **Member-access attribution caveat.** The shared `_ts_collect_refs` reads the
  TS field names `object`/`property` on `member_node`. Grammars that name those
  fields differently (Go `selector_expression` uses `operand`/`field`) still
  produce the correct **file→file edge** via the whole-module-import path, but
  `sym_refs` attributes it to the module rather than the symbol. `sym_refs` only
  feeds headline-symbol ranking, so PageRank/edges are unaffected. To fix it
  properly, make the member field names spec-configurable.

See `langspec.py`'s bundled Go spec as the worked example.

## What this is / isn't

It's grep-class on the ~80% of agent queries that are about *structure and
naming*: where is `X`, who calls `X`, what's in folder `Y`, orient me. It is
**not** semantic/paraphrase retrieval — map your words to the atlas's headline
symbols first. Layer a vector DB on top if you need concept search with zero
token overlap.

## License

Public domain / CC0.
