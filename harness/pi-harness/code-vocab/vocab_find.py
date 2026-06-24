#!/usr/bin/env python3
"""vocab_find.py -- CLI symbol lookup over a ctags `tags.json`.

Five modes:
  * definitions (default): "where is X defined?" -- reads tags.json (ctags).
  * --usages: "who calls / imports X?" -- ripgrep (preferred) or pure-Python
    fallback walker.
  * --imports <PATH>: "what does PATH import?" -- reads graph cache.
  * --imported-by <PATH>: "who imports PATH?" -- reads graph cache.
  * --neighbors <PATH>: both directions for PATH.
  * --entries [SCOPE]: list entry-point files from cache.

Deterministic, stdlib only. See docs/code-vocab-design.txt §18.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import fnmatch
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Emit UTF-8 regardless of the OS locale. On Windows a spawned subprocess gets
# cp1252 stdout by default, which raises UnicodeEncodeError on any symbol /
# signature containing non-cp1252 chars (CJK identifiers, em-dashes, …) and
# would crash the tool when the extension captures our output.
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

KIND_PRIORITY = {"class": 0, "function": 1, "method": 2, "variable": 3}

_USAGE_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs",
    ".java", ".kt", ".rb", ".c", ".cc", ".cpp", ".h", ".hpp",
    ".swift", ".cs", ".php", ".lua",
}
_USAGE_SKIP_DIRS = {"node_modules", "dist", "build", "target", "__pycache__",
                    ".git", ".venv", "venv"}
_RG_EXCLUDES = ["-g", "!node_modules", "-g", "!dist", "-g", "!build",
                "-g", "!target", "-g", "!__pycache__", "-g", "!.git",
                # our own generated artifacts — never report them as usages
                "-g", "!tags.json", "-g", "!tags.json.cache", "-g", "!vocabulary.md"]
# Generated artifacts the pure-Python fallback must also skip (rg uses globs above).
_ARTIFACT_NAMES = {"tags.json", "tags.json.cache", "vocabulary.md"}



# --------------------------------------------------------------------------- #
# Graph cache loader + entry-point detection + query functions                #
# --------------------------------------------------------------------------- #

def _load_graph_cache(tags_path: Path) -> dict | None:
    """Load tags.json.cache (produced by make_vocab.py). None on miss/error."""
    cache_path = tags_path.with_suffix(tags_path.suffix + ".cache")
    if not cache_path.is_file():
        return None
    try:
        return json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _normalize_path(p: str) -> str:
    return p.replace("\\", "/").removeprefix("./").rstrip("/")


def _is_under(file_path: str, folder_norm: str) -> bool:
    """True if `file_path` is `folder_norm` itself or a descendant."""
    fn = _normalize_path(file_path)
    return fn == folder_norm or fn.startswith(folder_norm + "/")


def _aggregate_to_folder(file_norm: str, target_depth: int) -> str:
    """Reduce a file path to its folder bucket at depth `target_depth`.

    For destinations shallower than the target depth (e.g. a single-segment
    file in the repo root), use whatever depth the file actually has.
    """
    parts = file_norm.split("/")
    if len(parts) - 1 < target_depth:
        return "/".join(parts[:-1]) if len(parts) > 1 else parts[0]
    return "/".join(parts[:target_depth])


def query_imports(
    tags_path: Path, target: str, root: Path,
) -> list[tuple[str, int]]:
    """Edges OUT of <target>: what does target import?

    File targets return file destinations. Folder targets aggregate both
    sides: source files under the folder are matched, destinations are
    rolled up to the same depth as the target folder.
    """
    cache = _load_graph_cache(tags_path)
    if cache is None:
        raise SystemExit(
            f"No graph cache at {tags_path}.cache. Run make_vocab.py first."
        )
    target_norm = _normalize_path(target)
    is_folder = bool(target_norm) and (root / target_norm).is_dir()
    target_depth = len(target_norm.split("/")) if target_norm else 0

    out: dict[str, int] = defaultdict(int)
    for src, dst, w in cache.get("edges", []):
        src_n = _normalize_path(src)
        dst_n = _normalize_path(dst)
        if is_folder:
            if not _is_under(src_n, target_norm):
                continue
            dst_bucket = _aggregate_to_folder(dst_n, target_depth)
            if dst_bucket == target_norm:
                continue  # within the same folder, skip
            out[dst_bucket] += w
        else:
            if src_n != target_norm:
                continue
            out[dst_n] += w
    return sorted(out.items(), key=lambda kv: -kv[1])


def query_imported_by(
    tags_path: Path, target: str, root: Path,
) -> list[tuple[str, int]]:
    """Edges INTO <target>: what imports target?"""
    cache = _load_graph_cache(tags_path)
    if cache is None:
        raise SystemExit(
            f"No graph cache at {tags_path}.cache. Run make_vocab.py first."
        )
    target_norm = _normalize_path(target)
    is_folder = bool(target_norm) and (root / target_norm).is_dir()
    target_depth = len(target_norm.split("/")) if target_norm else 0

    out: dict[str, int] = defaultdict(int)
    for src, dst, w in cache.get("edges", []):
        src_n = _normalize_path(src)
        dst_n = _normalize_path(dst)
        if is_folder:
            if not _is_under(dst_n, target_norm):
                continue
            src_bucket = _aggregate_to_folder(src_n, target_depth)
            if src_bucket == target_norm:
                continue
            out[src_bucket] += w
        else:
            if dst_n != target_norm:
                continue
            out[src_n] += w
    return sorted(out.items(), key=lambda kv: -kv[1])


def query_neighbors(
    tags_path: Path, target: str, root: Path,
) -> dict[str, list[tuple[str, int]]]:
    """Both directions for <target>."""
    return {
        "imports": query_imports(tags_path, target, root),
        "imported_by": query_imported_by(tags_path, target, root),
    }


def render_graph_query(
    direction: str, target: str, hits: list[tuple[str, int]],
) -> str:
    """Markdown for a single-direction graph query result."""
    titles = {
        "imports": f"# Imports from `{target}` \u2014 {len(hits)} target(s)",
        "imported_by": f"# Imported-by `{target}` \u2014 {len(hits)} consumer(s)",
    }
    lines = [titles.get(direction, f"# {direction} of `{target}`"), ""]
    if not hits:
        lines.append("_(no edges)_")
        return "\n".join(lines)
    for path, w in hits:
        lines.append(f"- `{path}`  \u00b7  {w} edge{'s' if w != 1 else ''}")
    return "\n".join(lines)


def _load_entry_points_from_cache(tags_path: Path) -> set[str]:
    """Pull the entry-points set from cache if make_vocab wrote one. Empty set
    on cache miss / older cache shape."""
    cache = _load_graph_cache(tags_path)
    if cache is None:
        return set()
    return set(cache.get("entry_points", []))


def list_entry_points(tags_path: Path, scope: str | None) -> list[str]:
    """Return entry-point file paths from the cache, optionally scoped to a
    folder prefix. Sorted by path for stable output.
    """
    cache = _load_graph_cache(tags_path)
    if cache is None:
        raise SystemExit(
            f"No graph cache at {tags_path}.cache. Run make_vocab.py first."
        )
    eps = cache.get("entry_points", []) or []
    if scope:
        scope_norm = _normalize_path(scope)
        eps = [
            e for e in eps
            if _is_under(e.replace("\\", "/").removeprefix("./"), scope_norm)
        ]
    return sorted(eps)


def render_entry_points(eps: list[str], scope: str | None) -> str:
    title = "# Entry points"
    if scope:
        title += f" under `{scope}`"
    title += f" \u2014 {len(eps)} file(s)"
    lines = [title, ""]
    if not eps:
        lines.append("_(no entry points detected)_")
        return "\n".join(lines)
    for path in eps:
        lines.append(f"- `{path}`")
    return "\n".join(lines)

def load_tags(tags_path: Path) -> list[dict]:
    if not tags_path.exists():
        sys.exit(f"tags file not found: {tags_path}\nRun the build first; see README.md.")
    out: list[dict] = []
    for line in tags_path.read_text(encoding="utf-8").splitlines():
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("_type") == "tag":
            out.append(obj)
    return out


def path_in_scope(path: str, scope: str | None) -> bool:
    if not scope:
        return True
    rel = path.removeprefix("./")
    scope = scope.rstrip("/")
    return rel == scope or rel.startswith(scope + "/")


def rank_def_hits(tags, query, mode):
    """Rank definition hits. Returns sorted list of (rank, tie, kind_priority, name, tag)."""
    q = query
    ql = query.lower()
    ranked = []
    for t in tags:
        name = t.get("name", "")
        if not name:
            continue
        if mode == "exact":
            if name != q:
                continue
            rank = 0
        elif mode == "regex":
            try:
                if not re.search(q, name):
                    continue
            except re.error:
                continue
            rank = 0
        elif mode == "glob":
            if not fnmatch.fnmatch(name, q):
                continue
            rank = 0
        else:  # substring (ranked)
            nl = name.lower()
            if name == q:
                rank = 0
            elif name.startswith(q):
                rank = 1
            elif q in name:
                rank = 2
            elif ql in nl:
                rank = 3
            else:
                continue
        kp = KIND_PRIORITY.get(t.get("kind", ""), 9)
        ranked.append((rank, len(name), kp, name, t))
    ranked.sort(key=lambda r: (r[0], r[1], r[2], r[3]))
    return ranked


def run_usages_ripgrep(pattern, search_root):
    rg = shutil.which("rg")
    if not rg:
        return None
    cmd = [rg, "--json", "--no-heading", "--line-number",
           *_RG_EXCLUDES, pattern, str(search_root)]
    try:
        # ripgrep emits UTF-8 JSON; decode it as UTF-8 explicitly. Without this,
        # text=True uses the OS locale (cp1252 on Windows) and mangles any
        # non-ASCII match text into mojibake (e.g. "—" -> "â€”").
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
    except OSError:
        return None
    if proc.returncode == 2:
        return None
    hits = []
    for line in proc.stdout.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") != "match":
            continue
        d = ev["data"]
        hits.append((d["path"]["text"], d["line_number"],
                     (d["lines"]["text"] or "").rstrip("\n")))
    return hits


def run_usages_python(pattern, search_root):
    try:
        rx = re.compile(pattern)
    except re.error:
        rx = re.compile(re.escape(pattern))
    hits = []
    root = Path(search_root)
    files = [root] if root.is_file() else root.rglob("*")
    for p in files:
        if p.is_dir():
            continue
        if p.name in _ARTIFACT_NAMES:
            continue
        parts = set(p.parts)
        if parts & _USAGE_SKIP_DIRS or any(seg.startswith(".") for seg in p.relative_to(root if root.is_dir() else root.parent).parts[:-1]):
            continue
        if p.suffix not in _USAGE_EXTS:
            continue
        try:
            if p.stat().st_size > 1_500_000:
                continue
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if rx.search(line):
                hits.append((str(p), i, line))
    return hits


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--tags", default="tags.json")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--regex", action="store_true", help="treat query as regex")
    p.add_argument("--exact", action="store_true", help="exact name match only")
    p.add_argument("--scope", default=None,
                   help="restrict hits to paths starting with this prefix")
    p.add_argument("--kind", default=None,
                   help="filter by ctags kind (function, class, method, ...)")
    p.add_argument("--root", default=".",
                   help="repo root for --usages / graph queries (default: cwd)")

    mode_group = p.add_mutually_exclusive_group()
    mode_group.add_argument("--usages", action="store_true",
                   help="find call-sites via ripgrep instead of definitions")
    mode_group.add_argument("--imports", action="store_true",
                   help="show files imported BY <query> (file or folder)")
    mode_group.add_argument("--imported-by", action="store_true",
                   help="show files that import FROM <query> (file or folder)",
                   dest="imported_by")
    mode_group.add_argument("--neighbors", action="store_true",
                   help="show both directions of import edges for <query>")
    mode_group.add_argument("--entries", action="store_true",
                   help="list entry-point files from the cache. <query> is "
                        "treated as an optional folder scope (use '.' for all).")

    p.add_argument("query",
                   help="symbol name (default / --usages) or path (graph queries)")
    args = p.parse_args()

    # Graph queries: <query> is a path
    if args.imports or args.imported_by or args.neighbors:
        root = Path(args.root).resolve()
        tags_path = Path(args.tags)
        if args.neighbors:
            both = query_neighbors(tags_path, args.query, root)
            print(render_graph_query("imports", args.query, both["imports"]))
            print()
            print(render_graph_query("imported_by", args.query, both["imported_by"]))
            return
        direction = "imports" if args.imports else "imported_by"
        hits = (query_imports(tags_path, args.query, root)
                if args.imports
                else query_imported_by(tags_path, args.query, root))
        print(render_graph_query(direction, args.query, hits))
        if not hits:
            sys.exit(1)
        return

    if args.entries:
        scope = None if args.query in (".", "") else args.query
        eps = list_entry_points(Path(args.tags), scope)
        print(render_entry_points(eps, scope))
        if not eps:
            sys.exit(1)
        return

    query = args.query
    if args.regex:
        mode = "regex"
    elif args.exact:
        mode = "exact"
    elif "*" in query or "?" in query:
        mode = "glob"
    else:
        mode = "substring"

    filt = []
    if args.scope:
        filt.append(f"scope={args.scope}")
    if args.kind:
        filt.append(f"kind={args.kind}")
    filt_str = f" [{', '.join(filt)}]" if filt else ""

    if args.usages:
        root = Path(args.root)
        search_root = root / args.scope if (args.scope and (root / args.scope).exists()) else root
        if mode == "regex":
            pattern = query
        elif mode == "glob":
            pattern = fnmatch.translate(query).rstrip(r"\Z")
        else:
            pattern = rf"\b{re.escape(query)}\b"
        hits = run_usages_ripgrep(pattern, search_root)
        if hits is None:
            hits = run_usages_python(pattern, search_root)
        hits = [h for h in hits if path_in_scope(h[0].replace("\\", "/"), args.scope)]
        if not hits:
            sys.exit(f"no usages for '{query}'")
        hits.sort(key=lambda h: (h[0].replace("\\", "/"), h[1]))
        hits = hits[:args.limit]
        folders = {}
        for path, _ln, _txt in hits:
            seg = "/".join(path.replace("\\", "/").removeprefix("./").split("/")[:2])
            folders[seg] = folders.get(seg, 0) + 1
        print(f"# Usages for '{query}' ({mode}){filt_str} \u2014 {len(hits)} shown\n")
        print("## Top folders")
        for seg, cnt in sorted(folders.items(), key=lambda kv: -kv[1]):
            print(f"- `{seg}/`  \u00b7  {cnt}")
        entry_set = _load_entry_points_from_cache(Path(args.tags))
        print("\n## Hits")
        for path, ln, txt in hits:
            entry_tag = " [entry]" if path in entry_set else ""
            print(f"- usage    `{path}:{ln}`  {txt.strip()[:120]}{entry_tag}")
        return

    # definitions mode
    tags = load_tags(Path(args.tags))
    if args.scope:
        tags = [t for t in tags if path_in_scope(t.get("path", ""), args.scope)]
    if args.kind:
        tags = [t for t in tags if t.get("kind") == args.kind]
    ranked = rank_def_hits(tags, query, mode)
    if not ranked:
        sys.exit(f"no matches for '{query}'")
    ranked = ranked[:args.limit]

    folders = {}
    for *_x, t in ranked:
        seg = "/".join(t.get("path", "").removeprefix("./").split("/")[:2])
        folders[seg] = folders.get(seg, 0) + 1

    print(f"# Matches for '{query}' ({mode}){filt_str} \u2014 {len(ranked)} shown\n")
    print("## Top folders")
    for seg, cnt in sorted(folders.items(), key=lambda kv: -kv[1]):
        print(f"- `{seg}/`  \u00b7  {cnt}")
    print("\n## Hits")
    entry_set = _load_entry_points_from_cache(Path(args.tags))
    for _rank, _tie, _kp, name, t in ranked:
        kind = t.get("kind", "")
        path = t.get("path", "")
        line = t.get("line", "")
        scope = t.get("scope", "")
        sig = t.get("signature", "")
        scope_part = f"  ({scope})" if scope else ""
        is_entry = (
            t.get("path", "") in entry_set
            or path in entry_set
            or f"./{path}" in entry_set
        )
        entry_tag = " [entry]" if is_entry else ""
        print(f"- {kind:<8} `{path}:{line}` `{name}`{scope_part}{sig}{entry_tag}")


if __name__ == "__main__":
    main()
