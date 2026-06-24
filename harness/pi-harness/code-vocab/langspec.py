"""Per-language configuration for the generic tree-sitter AST tier.

Each LangSpec tells the generic parser which tree-sitter node types denote
definitions and imports, how to collect references, how to resolve an import
specifier to a repo-relative file path, and how to recognize an entry point.

Adding a language = add one LangSpec to LANG_SPECS. No parser code changes.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass(frozen=True)
class LangSpec:
    name: str                       # human label, e.g. "go"
    grammar: str                    # tree-sitter-language-pack key, e.g. "go"
    exts: tuple[str, ...]           # file extensions, e.g. (".go",)

    # node.type -> kind ("class"|"function"|"constant"); the parser reads the
    # node's child_by_field_name("name") to get the declared symbol.
    def_nodes: dict[str, str]

    # tree-sitter node type for a "member"/"selector" access (obj.attr).
    member_node: str

    # node type that wraps imports at top level.
    import_node: str

    # Given (specifier, current_file_rel, root) return a repo-relative POSIX
    # path or None. Used to turn an import into a file->file edge target.
    resolve_import: Callable[[str, str, Path], "str | None"]

    # Extract import bindings from one import_node subtree.
    # Returns list[(local_name, specifier, imported_name)] where imported_name
    # is "" for whole-module imports (Go/most langs) or a symbol name.
    extract_imports: Callable[["object"], "list[tuple[str, str, str]]"]

    # Is a declared/exported name visible to other files? (Go: Capitalized.)
    is_exported: Callable[[str], bool] = field(default=lambda n: True)

    # Module-scope entry-point patterns (regex over file source).
    entry_patterns: tuple[re.Pattern, ...] = ()


# Registry keyed by extension. Populated below.
LANG_SPECS: dict[str, LangSpec] = {}


def register(spec: LangSpec) -> None:
    for ext in spec.exts:
        LANG_SPECS[ext] = spec


# --------------------------------------------------------------------------- #
# Go
# --------------------------------------------------------------------------- #

def _go_extract_imports(import_node) -> "list[tuple[str, str, str]]":
    """Go: `import "fmt"` and `import ( "a"; alias "b" )`.

    Binds the package's *last path segment* (or the explicit alias) as a
    module object. Returns (local_name, import_path, "").
    """
    out: list[tuple[str, str, str]] = []

    def handle_spec(spec_node):
        # import_spec: optional package_identifier alias + string-literal path
        alias = None
        path = None
        for ch in spec_node.named_children:
            if ch.type in ("package_identifier", "identifier", "blank_identifier"):
                alias = ch.text.decode("utf-8", "replace")
            elif ch.type in ("interpreted_string_literal", "raw_string_literal"):
                raw = ch.text.decode("utf-8", "replace")
                path = raw.strip('"`')
        if path is None:
            return
        local = alias if alias else path.rsplit("/", 1)[-1]
        out.append((local, path, ""))

    for ch in import_node.named_children:
        if ch.type == "import_spec":
            handle_spec(ch)
        elif ch.type == "import_spec_list":
            for s in ch.named_children:
                if s.type == "import_spec":
                    handle_spec(s)
    return out


def _go_resolve_import(spec: str, current_file_rel: str, root: Path) -> "str | None":
    """Resolve a Go import path to a directory of .go files in this repo.

    Go imports are package *paths* (e.g. "github.com/me/proj/internal/db").
    We can only resolve intra-repo imports: match the import-path tail against
    a directory containing .go files. Returns the first .go file in that dir
    as the attribution target, or None for stdlib/external packages.
    """
    tail = spec.split("/")
    # Try progressively shorter suffixes of the import path as a repo dir.
    for start in range(len(tail)):
        cand_dir = root / Path(*tail[start:])
        if cand_dir.is_dir():
            go_files = sorted(cand_dir.glob("*.go"))
            if go_files:
                try:
                    return go_files[0].relative_to(root).as_posix()
                except ValueError:
                    return None
    return None


register(LangSpec(
    name="go",
    grammar="go",
    exts=(".go",),
    def_nodes={
        "function_declaration": "function",
        "method_declaration": "function",
        "type_declaration": "class",
        "const_declaration": "constant",
        "var_declaration": "constant",
    },
    member_node="selector_expression",
    import_node="import_declaration",
    resolve_import=_go_resolve_import,
    extract_imports=_go_extract_imports,
    is_exported=lambda n: bool(n) and n[0].isupper(),
    entry_patterns=(
        re.compile(r'^package\s+main\b', re.M),
        re.compile(r'^func\s+main\s*\(', re.M),
    ),
))
