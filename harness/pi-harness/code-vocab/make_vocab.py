#!/usr/bin/env python3
"""Adaptive codebase vocabulary builder.

A small, dependency-free tool that turns a ctags index into a token-budgeted
markdown brief an LLM can auto-attach as orientation for any codebase.

Three modes:
  - full     : module-level detail allocated greedily against a token budget.
               Good for tiny/small projects (a few dozen files).
  - atlas    : folder roll-ups. Constant token cost (~atlas-budget). The LLM
               reads this first, then drills into a folder via section mode.
  - section  : same as full but scoped to a sub-folder (`--scope <rel-path>`).

Pipeline (shared across modes):
  EXTRACT  ctags + language-agnostic comment/constant extractor
           (+ Python AST for typed dataclass fields)
  SCORE    file-level PageRank over the reference graph (cached to disk).
           Two builders:
             - "ast" (default): AST-driven references for Python (no false
               edges from comments/strings; imports disambiguate multi-defined
               symbols) + comment/string-stripped lexical scan for other
               languages.
             - "lexical": v1 token-based scan; lossier but language-agnostic
               with no AST cost.
  RENDER   mode-specific markdown
...
"""
from __future__ import annotations

import argparse
import ast
import json
import os       # NEW: used by entry-point glob walk
import re
import sys      # NEW: used by --graph-builder both stderr print
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

# Emit UTF-8 regardless of OS locale so the final summary line never crashes a
# piped subprocess on Windows (cp1252). vocabulary.md is already written utf-8.
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

# --------------------------------------------------------------------------- #
# 5.1 Module-level constants
# --------------------------------------------------------------------------- #
WORD_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{2,}\b")
TEST_PATH_RE = re.compile(
    r"(^|/)tests?/|(^|/)test_[^/]+\.py$|\.(test|spec)\.[tj]sx?$"
)

NOISE_NAMES = frozenset({
    "void", "this", "self", "resolve", "reject", "then", "catch", "finally",
    "process", "window", "document", "value", "name", "data", "result",
    "error", "err", "item", "items", "args", "opts", "options", "config",
    "context", "input", "output", "target", "source", "key", "index",
    "time", "date", "timer", "timeout", "width", "height", "size", "text",
    "code", "line", "lines", "path", "file", "files", "node", "nodes",
    "branch", "main", "init", "start", "stop", "run", "exec", "call",
    "send", "receive", "open", "close", "read", "write", "load", "save",
    "get", "set", "add", "remove", "update", "create", "delete", "clear",
    "move", "copy", "render", "draw", "paint", "toggle", "space", "heading",
    "prompt", "stream", "complete", "login", "logout", "notify", "cleanup",
    "question", "padLine", "client", "server", "step", "steps", "phase",
    "keyHint", "keyText", "flag", "flags", "state", "states",
})

_BLOCK_COMMENTS = [
    ('"""', '"""'),
    ("'''", "'''"),
    ("/**", "*/"),
    ("/*", "*/"),
    ("<!--", "-->"),
    ("=begin", "=end"),
]
_LINE_COMMENT_PREFIXES = ("#", "//", "---", "--", ";;")

_CONST_RE = re.compile(
    r"^(?:export\s+|pub\s+)?(?:const\s+|let\s+|var\s+)?([A-Z][A-Z0-9_]{2,})\s*[:=]"
)
_CONST_VAL_RE = re.compile(r"[:=]\s*(.+?)(?://|/\*|$)")

KIND_PRIORITY = {"class": 0, "function": 1, "method": 2, "variable": 3}


# --------------------------------------------------------------------------- #
# 6. Token counting
# --------------------------------------------------------------------------- #
try:
    import tiktoken
    _ENC = tiktoken.get_encoding("cl100k_base")

    def count_tokens(text: str) -> int:
        return len(_ENC.encode(text))
except Exception:
    def count_tokens(text: str) -> int:
        return max(1, len(text) // 4)


# --------------------------------------------------------------------------- #
# 5.2 / 5.3 dataclasses
# --------------------------------------------------------------------------- #
@dataclass
class ModuleItem:
    path: str
    score: float
    pr_pct: float
    n_public: int
    L0: str
    L1: str
    L2: str
    L3: str

    def render(self, level: int) -> str:
        return getattr(self, f"L{level}")


@dataclass
class FolderBucket:
    prefix: str
    files: list[str]
    pr_pct: float


# --------------------------------------------------------------------------- #
# 7. Tags loading
# --------------------------------------------------------------------------- #
def load_tags(tags_path: Path) -> list[dict]:
    if not tags_path.exists():
        raise SystemExit(
            f"tags file not found: {tags_path}\n"
            "Run `ctags --recurse --output-format=json ...` first; see README.md."
        )
    out: list[dict] = []
    for line in tags_path.read_text(encoding="utf-8").splitlines():
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("_type") == "tag":
            out.append(obj)
    return out


# --------------------------------------------------------------------------- #
# 8. Per-file extraction
# --------------------------------------------------------------------------- #
def is_test_path(path: str) -> bool:
    return bool(TEST_PATH_RE.search(path))


def safe_read(root: Path, rel: str, limit: int = 1_500_000) -> str:
    try:
        p = root / rel.removeprefix("./")
        if not p.is_file():
            return ""
        if p.stat().st_size > limit:
            return ""
        return p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def extract_python_facts(root: Path, rel: str) -> dict:
    src = safe_read(root, rel)
    facts = {"docstring": "", "constants": [], "classes": {}, "has_routes": False}
    if not src:
        return facts
    facts["has_routes"] = ("@app." in src) or ("@router." in src)
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return facts
    doc = ast.get_docstring(tree)
    if doc:
        for line in doc.splitlines():
            if line.strip():
                facts["docstring"] = line.strip()[:160]
                break
    constants: list[tuple[str, str]] = []
    classes: dict[str, list[tuple[str, str]]] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 \
                and isinstance(node.targets[0], ast.Name):
            nm = node.targets[0].id
            if nm.isidentifier() and nm.isupper() and len(nm) >= 3 and nm[0].isalpha():
                try:
                    val = ast.unparse(node.value)
                except Exception:
                    val = ""
                if val and len(val) <= 40:
                    constants.append((nm, val))
        elif isinstance(node, ast.ClassDef):
            fields: list[tuple[str, str]] = []
            for child in node.body:
                if isinstance(child, ast.AnnAssign) and isinstance(child.target, ast.Name):
                    fn = child.target.id
                    if fn.startswith("_"):
                        continue
                    try:
                        ann = ast.unparse(child.annotation).replace(" ", "")[:30]
                    except Exception:
                        ann = ""
                    fields.append((fn, ann))
            if fields:
                classes[node.name] = fields
    facts["constants"] = constants
    facts["classes"] = classes
    return facts


def extract_lead_doc(src: str) -> str:
    if not src:
        return ""
    if src.startswith("#!"):
        nl = src.find("\n")
        src = src[nl + 1:] if nl >= 0 else ""
    src = src.lstrip("\n")
    first_nl = src.find("\n")
    first_line = src[:first_nl] if first_nl >= 0 else src
    if first_line.startswith("# -*-") or first_line.startswith("# coding"):
        src = src[first_nl + 1:] if first_nl >= 0 else ""
    head = src[:3000]
    stripped = head.lstrip()
    # Block-comment path
    for opener, closer in _BLOCK_COMMENTS:
        if stripped.startswith(opener):
            after = stripped[len(opener):]
            end = after.find(closer)
            if end < 0:
                return ""
            body = after[:end]
            for line in body.splitlines():
                cleaned = line.strip()
                if cleaned.startswith("* "):
                    cleaned = cleaned[2:].strip()
                elif cleaned == "*":
                    cleaned = ""
                if cleaned:
                    return cleaned[:160]
            return ""
    # Line-comment path
    block: list[str] = []
    for line in head.splitlines():
        if not line.lstrip():
            if block:
                break
            continue
        if not any(line.lstrip().startswith(pfx) for pfx in _LINE_COMMENT_PREFIXES):
            break
        text = line.lstrip()
        for pfx in _LINE_COMMENT_PREFIXES:
            if text.startswith(pfx):
                text = text[len(pfx):]
                break
        text = text.strip()
        if text:
            block.append(text)
        if len(block) >= 5:
            break
    return block[0][:160] if block else ""


def extract_constants_generic(src: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    if not src:
        return out
    for line in src.splitlines()[:400]:
        if not line or line[0] in (" ", "\t"):
            continue
        m = _CONST_RE.match(line)
        if not m:
            continue
        name = m.group(1)
        vm = _CONST_VAL_RE.search(line)
        val = vm.group(1).strip() if vm else ""
        val = val.rstrip(";,").strip()
        if len(val) > 40:
            val = val[:37] + "…"
        out.append((name, val))
        if len(out) >= 8:
            break
    return out


def extract_facts(root: Path, rel: str) -> dict:
    if rel.endswith(".py"):
        facts = extract_python_facts(root, rel)
        if not facts["docstring"]:
            facts["docstring"] = extract_lead_doc(safe_read(root, rel))
        return facts
    src = safe_read(root, rel)
    return {
        "docstring": extract_lead_doc(src),
        "constants": extract_constants_generic(src),
        "classes": {},
        "has_routes": False,
    }


def project_metadata(root: Path) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()

    def add(label: str, value: str) -> None:
        key = f"{label}={value}"
        if value and key not in seen:
            seen.add(key)
            out.append(f"**{label}:** `{value}`" if label in ("Name",) else f"**{label}:** {value}")

    # pyproject.toml: prefer the root one, else the first one-level-deep match.
    pyprojects = [root / "pyproject.toml"] + sorted(root.glob("*/pyproject.toml"))
    pp = next((p for p in pyprojects if p.exists()), None)
    if pp is not None:
        txt = pp.read_text(encoding="utf-8", errors="ignore")
        m = re.search(r'^name\s*=\s*"([^"]+)"', txt, re.M)
        if m:
            add("Name", m.group(1))
        m = re.search(r'^description\s*=\s*"([^"]+)"', txt, re.M)
        if m:
            add("Description", m.group(1))
        m = re.search(r"dependencies\s*=\s*\[([^\]]*)\]", txt)
        if m:
            deps = re.findall(r'"([a-zA-Z0-9._\-]+)"', m.group(1))[:10]
            if deps:
                add("Python deps", ", ".join(f"`{d}`" for d in deps))

    pkg = root / "package.json"
    if pkg.exists():
        try:
            data = json.loads(pkg.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            data = {}
        if isinstance(data, dict):
            if data.get("name"):
                add("Name", str(data["name"]))
            if data.get("description"):
                add("Description", str(data["description"]))
            deps = list((data.get("dependencies") or {}).keys())[:10]
            if deps:
                add("JS deps", ", ".join(f"`{d}`" for d in deps))
            ws = data.get("workspaces")
            if isinstance(ws, list) and ws:
                add("Workspaces", ", ".join(f"`{w}`" for w in ws[:6]))
    return out


def extract_glossary(root: Path) -> list[tuple[str, str]]:
    readme = root / "README.md"
    if not readme.exists():
        return []
    skip = {"status", "additional links", "license", "files", "contributing"}
    lines = readme.read_text(encoding="utf-8", errors="ignore").splitlines()
    out: list[tuple[str, str]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("## ") and not line.startswith("###"):
            title = line[3:].strip()
            if title.lower() in skip:
                i += 1
                continue
            j = i + 1
            while j < len(lines):
                cand = lines[j].strip()
                if cand and not cand.startswith("#"):
                    cand = re.sub(r"^[-*+]\s+", "", cand)
                    cand = re.sub(r"^\d+[.)]\s+", "", cand)
                    if 10 < len(cand) < 220:
                        out.append((title, cand))
                    break
                if cand.startswith("#"):
                    break
                j += 1
            if len(out) >= 6:
                break
        i += 1
    return out[:6]


_ROUTE_RE = re.compile(
    r'@(?:app|router)\.(get|post|put|delete|patch)\(\s*["\']([^"\']+)["\'][^)]*\)'
    r'\s*\n(?:async\s+)?def\s+([A-Za-z_]\w*)'
)


def extract_routes(root: Path, files: list[str]) -> list[tuple[str, str, str, str]]:
    out: list[tuple[str, str, str, str]] = []
    for rel in files:
        if not rel.endswith(".py"):
            continue
        src = safe_read(root, rel)
        if "@app." not in src and "@router." not in src:
            continue
        for m in _ROUTE_RE.finditer(src):
            out.append((m.group(1).upper(), m.group(2), m.group(3), rel))
    return out


_TREE_SKIP = {
    ".git", ".venv", "venv", "node_modules", "dist", "build", "target",
    "out", "__pycache__", ".idea", ".vscode", ".husky", ".github",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".next",
    ".nuxt", ".cache", ".turbo", "coverage", ".coverage",
}


def folder_tree(root: Path, depth: int = 2) -> list[str]:
    def skip_dir(name: str) -> bool:
        return name in _TREE_SKIP or name.startswith(".") or name.endswith(".egg-info")

    lines: list[str] = []

    def walk(d: Path, prefix: str, level: int) -> None:
        if level > depth:
            return
        try:
            entries = sorted(p for p in d.iterdir() if p.is_dir() and not skip_dir(p.name))
        except OSError:
            return
        for e in entries:
            lines.append(f"{'  ' * (level - 1)}- `{e.name}/`")
            walk(e, prefix, level + 1)

    walk(root, "", 1)
    return lines


# --------------------------------------------------------------------------- #
# 9. Symbol reference graph + PageRank
# --------------------------------------------------------------------------- #
def build_reference_graph(root: Path, tags: list[dict]):
    raw_defines: dict[str, set[str]] = defaultdict(set)
    for t in tags:
        kind = t.get("kind", "")
        name = t.get("name", "")
        path = t.get("path", "")
        if kind not in ("function", "class", "method"):
            continue
        if not name or not path or name.startswith("_"):
            continue
        if kind != "class" and len(name) < 4:
            continue
        scope = t.get("scope")
        scope_kind = t.get("scopeKind", "")
        if scope and scope_kind not in ("", "class"):
            continue
        raw_defines[name].add(path)

    defines = {n: ps for n, ps in raw_defines.items() if len(ps) == 1}
    name_to_path = {n: next(iter(ps)) for n, ps in defines.items()}

    files: set[str] = {t.get("path", "") for t in tags if t.get("path")}
    edges: dict[tuple[str, str], int] = defaultdict(int)
    sym_refs: dict[str, int] = defaultdict(int)

    for src_file in files:
        text = safe_read(root, src_file)
        if not text:
            continue
        tokens = set(WORD_RE.findall(text))
        for tok in tokens:
            dst = name_to_path.get(tok)
            if dst and dst != src_file:
                edges[(src_file, dst)] += 1
                sym_refs[tok] += 1

    return sorted(files), dict(edges), defines, dict(sym_refs)


def pagerank(nodes, edges, damping=0.85, max_iter=80, tol=1e-7):
    n = len(nodes)
    if n == 0:
        return {}
    pr = {node: 1.0 / n for node in nodes}
    out = {node: [] for node in nodes}
    out_w = {node: 0.0 for node in nodes}
    for (src, dst), w in edges.items():
        if src in out and dst in out:
            out[src].append((dst, w))
            out_w[src] += w
    for _ in range(max_iter):
        teleport = (1 - damping) / n
        dangling = sum(pr[node] for node in nodes if out_w[node] == 0)
        new_pr = {node: teleport + damping * dangling / n for node in nodes}
        for src in nodes:
            ws = out_w[src]
            if ws == 0:
                continue
            base = damping * pr[src] / ws
            for dst, w in out[src]:
                new_pr[dst] += base * w
        delta = sum(abs(new_pr[k] - pr[k]) for k in nodes)
        pr = new_pr
        if delta < tol:
            break
    return pr


def _cache_key(tags_path: Path, builder: str) -> str:
    st = tags_path.stat()
    return f"v2-{builder}-{int(st.st_mtime_ns)}-{st.st_size}"


def build_graph_cached(
    root: Path,
    tags_path: Path,
    tags: list[dict],
    builder: str = "ast",
) -> tuple[list[str], dict[tuple[str, str], int], dict[str, set[str]], dict[str, int], dict[str, float]]:
    """Return (files, edges, defines, sym_refs, pr), memoized to disk.

    `builder` selects the reference graph:
      - "ast": AST-driven for Python, comment-stripped lexical for other languages.
      - "lexical": v1 fallback (token-only, language-agnostic).

    Cache key includes builder + tags.json mtime/size so switching builders
    auto-invalidates without manual cleanup.
    """
    cache_path = tags_path.with_suffix(tags_path.suffix + ".cache")
    key = _cache_key(tags_path, builder)
    if cache_path.is_file():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("key") == key:
                edges = {(e[0], e[1]): e[2] for e in cached["edges"]}
                defines = {n: set(ps) for n, ps in cached["defines"].items()}
                return (
                    cached["files"],
                    edges,
                    defines,
                    {n: int(c) for n, c in cached["sym_refs"].items()},
                    {f: float(v) for f, v in cached["pr"].items()},
                )
        except (OSError, json.JSONDecodeError, KeyError, ValueError):
            pass

    if builder == "ast":
        files, edges, defines, sym_refs = build_graph_v2(root, tags)
    else:
        files, edges, defines, sym_refs = build_reference_graph(root, tags)
    pr = pagerank(files, edges)
    try:
        cache_path.write_text(
            json.dumps({
                "key": key,
                "files": files,
                "edges": [[s, d, w] for (s, d), w in edges.items()],
                "defines": {n: sorted(ps) for n, ps in defines.items()},
                "sym_refs": sym_refs,
                "pr": pr,
            }),
            encoding="utf-8",
        )
    except OSError:
        pass
    return files, edges, defines, sym_refs, pr


# =========================================================================== #
# v2 graph: AST-driven for Python, comment/string-stripped lexical for others #
# =========================================================================== #

@dataclass
class ImportRef:
    """An import binding: in this file, `local_name` refers to `name` from `module`.

    `name == ""` means the binding refers to the module object itself
    (e.g. `import foo` or `import foo as f`).
    """
    module: str
    name: str


@dataclass
class FileAst:
    path: str                                   # repo-relative POSIX path
    module: str                                 # dotted module name (e.g. "pkg.sub.mod")
    is_package: bool                            # True iff path ends in __init__.py
    defines: dict[str, str]                     # top-level name -> "class"|"function"|"constant"
    imports: dict[str, ImportRef]               # local name -> binding
    star_imports: list[str]                     # modules with `from X import *`
    references: list[tuple[str, str | None]]    # (top_name, attr_or_None); Load context only


# --- Path -> dotted module ------------------------------------------------- #

def _path_to_module(rel: str, root: Path) -> tuple[str, bool]:
    """Compute (dotted_module_name, is_package) from a repo-relative .py path.

    A file is in a package iff every ancestor directory below the first
    non-package ancestor contains an `__init__.py`. Files not in any package
    fall back to the bare basename (e.g. `loose.py` -> `"loose"`).
    """
    rel = rel.replace("\\", "/").removeprefix("./")
    parts = rel.split("/")
    is_package = parts[-1] == "__init__.py"
    dir_parts = parts[:-1]

    # Find the first ancestor (walking inward) that is NOT a package; everything
    # below it is unreachable as a package and starts the module path fresh.
    pkg_start = 0
    cur_rel = ""
    for i, p in enumerate(dir_parts):
        cur_rel = f"{cur_rel}/{p}" if cur_rel else p
        if not (root / cur_rel / "__init__.py").is_file():
            pkg_start = i + 1

    pkg_dirs = dir_parts[pkg_start:]
    mod_parts = pkg_dirs if is_package else pkg_dirs + [parts[-1][:-3]]
    if not mod_parts:
        return ("", True)
    return (".".join(mod_parts), is_package)


# --- Relative import resolver --------------------------------------------- #

def resolve_relative(
    current_module: str, is_package: bool, level: int, target: str
) -> str:
    """Resolve a relative import target to its absolute dotted module name.

    `level` is the number of leading dots (1 = current package, 2 = parent, ...).
    `target` is what follows the dots ("" for `from . import X`-style bare).
    For __init__.py files, `is_package=True` shifts the anchor by one (the
    file itself IS the package).
    """
    parts = current_module.split(".") if current_module else []
    up = level if not is_package else level - 1
    if up > len(parts):
        # going above package root; degenerate, return target as-is
        return target
    base = parts[:-up] if up > 0 else parts[:]
    if target:
        return ".".join(base + [target])
    return ".".join(base)


# --- Reference collector --------------------------------------------------- #

class _RefCollector(ast.NodeVisitor):
    """Collect (top_name, attr_or_None) Load-context references.

    For an Attribute chain like `a.b.c`, emits only ("a", "b") -- the leftmost
    Name and the first attribute -- and does NOT also emit ("a", None). This
    prevents double-counting where a bare name and its attribute access both
    register.
    """
    def __init__(self) -> None:
        self.refs: list[tuple[str, str | None]] = []

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if not isinstance(node.ctx, ast.Load):
            self.generic_visit(node)
            return
        # Walk down to the leftmost element of the attribute chain
        cur: ast.AST = node
        first_attr = node.attr
        while isinstance(cur, ast.Attribute):
            first_attr = cur.attr if isinstance(cur.value, ast.Name) else first_attr
            cur = cur.value
        if isinstance(cur, ast.Name):
            # Reconstruct: leftmost Name + the attribute closest to it
            inner: ast.AST = node
            while isinstance(inner.value, ast.Attribute):  # type: ignore[union-attr]
                inner = inner.value  # type: ignore[union-attr]
            assert isinstance(inner, ast.Attribute) and isinstance(inner.value, ast.Name)
            self.refs.append((inner.value.id, inner.attr))
        else:
            # base is a call or subscript or something — just walk through
            self.visit(cur)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load):
            self.refs.append((node.id, None))


# --- Per-file AST extraction ---------------------------------------------- #

def parse_python_ast(root: Path, rel: str) -> FileAst | None:
    rel_norm = rel.replace("\\", "/").removeprefix("./")
    p = root / rel_norm
    if not p.is_file():
        return None
    src = safe_read(root, rel_norm)   # may be "" for genuinely empty files (e.g. __init__.py)
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None

    module, is_package = _path_to_module(rel_norm, root)

    defines: dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if not node.name.startswith("_"):
                defines[node.name] = "function"
        elif isinstance(node, ast.ClassDef):
            if not node.name.startswith("_"):
                defines[node.name] = "class"
        elif isinstance(node, ast.Assign):
            for tgt in node.targets:
                if (isinstance(tgt, ast.Name) and not tgt.id.startswith("_")
                        and tgt.id.isidentifier()):
                    defines[tgt.id] = "constant"
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            n = node.target.id
            if not n.startswith("_"):
                defines[n] = "constant"

    imports: dict[str, ImportRef] = {}
    star_imports: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    imports[alias.asname] = ImportRef(module=alias.name, name="")
                else:
                    # `import a.b.c` binds the top-level name `a` to package `a`
                    top = alias.name.split(".")[0]
                    imports[top] = ImportRef(module=top, name="")
                    # also remember the full module under its full dotted alias
                    # so `a.b.c.X` chains can be resolved via the attribute walker
                    imports[alias.name] = ImportRef(module=alias.name, name="")
        elif isinstance(node, ast.ImportFrom):
            if node.level > 0:
                base = resolve_relative(module, is_package, node.level, node.module or "")
            else:
                base = node.module or ""
            for alias in node.names:
                if alias.name == "*":
                    if base:
                        star_imports.append(base)
                    continue
                local = alias.asname or alias.name
                imports[local] = ImportRef(module=base, name=alias.name)

    collector = _RefCollector()
    collector.visit(tree)

    return FileAst(
        path=rel,
        module=module,
        is_package=is_package,
        defines=defines,
        imports=imports,
        star_imports=star_imports,
        references=collector.refs,
    )


# --- Module index --------------------------------------------------------- #

def build_module_index(root: Path, py_files: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for rel in py_files:
        module, _ = _path_to_module(rel, root)
        if module:
            out[module] = rel
    return out


# --- Re-export map -------------------------------------------------------- #

def build_re_exports(
    asts: dict[str, FileAst],
    module_index: dict[str, str],
) -> dict[str, dict[str, ImportRef]]:
    """For each package, expose names brought in via imports in its __init__.py.

    Returns {package_dotted_module: {exposed_local_name: origin ImportRef}}.
    Re-export chains are followed at lookup time, not eagerly here.
    """
    out: dict[str, dict[str, ImportRef]] = {}
    for fa in asts.values():
        if not fa.is_package:
            continue
        if not fa.module:
            continue
        out[fa.module] = dict(fa.imports)
    return out


# --- Resolve a (module, name) through re-exports -------------------------- #

def _resolve_symbol(
    module: str,
    name: str,
    asts: dict[str, FileAst],
    module_index: dict[str, str],
    re_exports: dict[str, dict[str, ImportRef]],
    depth: int = 4,
) -> str | None:
    """Find the file path that actually defines `name` reachable from `module`."""
    if depth <= 0 or not module:
        return None
    path = module_index.get(module)
    if not path:
        return None
    fa = asts.get(path)
    if fa is None:
        return path  # we know the file but couldn't parse it; best-effort attribute
    if name in fa.defines:
        return path
    # TS default exports: name="default" never appears in defines but is the
    # implicit name of `export default <thing>`. Attribute to the module file.
    if name == "default":
        return path
    re = re_exports.get(module, {})
    if name in re:
        imp = re[name]
        next_name = imp.name or name
        return _resolve_symbol(imp.module, next_name, asts, module_index, re_exports, depth - 1)
    return None


# --- Per-reference attribution -------------------------------------------- #

def _attribute_ref(
    fa: FileAst,
    top: str,
    attr: str | None,
    asts: dict[str, FileAst],
    module_index: dict[str, str],
    re_exports: dict[str, dict[str, ImportRef]],
) -> tuple[str, str] | None:
    """Resolve one reference to (defining_file, resolved_name) or None.

    Order: local define -> import (with re-export chase) -> star imports.
    No single-global-definer fallback: it manufactures false edges whenever a
    file uses an external/built-in name (e.g. `readFileSync` from `node:fs`)
    that happens to be redefined locally in some other file. If the file did
    not explicitly import the name, the right answer is 'no edge'.
    """
    if top in fa.defines:
        return None  # local
    if top in fa.imports:
        imp = fa.imports[top]
        if not imp.name:
            # `import foo` or `import foo as f` -> top binds the module itself
            target_name = attr if attr else ""
            if target_name:
                hit = _resolve_symbol(imp.module, target_name, asts, module_index, re_exports)
                if hit:
                    return (hit, target_name)
            # bare module reference; attribute to the module's own file
            path = module_index.get(imp.module)
            return (path, imp.module.split(".")[-1]) if path else None
        # `from x import Y [as Z]` -> top binds Y in module x
        hit = _resolve_symbol(imp.module, imp.name, asts, module_index, re_exports)
        if hit:
            return (hit, imp.name)
        return None
    for src_module in fa.star_imports:
        hit = _resolve_symbol(src_module, top, asts, module_index, re_exports)
        if hit:
            return (hit, top)
    return None


# --- Top-level Python graph ----------------------------------------------- #

def build_python_graph(
    root: Path,
    py_files: list[str],
) -> tuple[dict[tuple[str, str], int], dict[str, set[str]], dict[str, int]]:
    """Build the AST-derived graph for the given Python files.

    Returns (edges, defines, sym_refs) matching the v1 shape so downstream
    PageRank / atlas code is unchanged. `defines` keeps multi-defines because
    attribution disambiguates them per use site.
    """
    asts: dict[str, FileAst] = {}
    for rel in py_files:
        fa = parse_python_ast(root, rel)
        if fa is not None:
            asts[fa.path] = fa

    module_index = build_module_index(root, py_files)
    re_exports = build_re_exports(asts, module_index)

    raw_defines: dict[str, set[str]] = defaultdict(set)
    for fa in asts.values():
        for name, kind in fa.defines.items():
            if kind != "class" and len(name) < 4:
                continue
            raw_defines[name].add(fa.path)

    edges: dict[tuple[str, str], int] = defaultdict(int)
    sym_refs: dict[str, int] = defaultdict(int)
    for fa in asts.values():
        seen_edges: set[tuple[str, str]] = set()
        for top, attr in fa.references:
            hit = _attribute_ref(
                fa, top, attr, asts, module_index, re_exports,
            )
            if hit is None:
                continue
            dst, resolved_name = hit
            if not dst or dst == fa.path:
                continue
            edge = (fa.path, dst)
            if edge in seen_edges:
                continue
            seen_edges.add(edge)
            edges[edge] += 1
            sym_refs[resolved_name] += 1

    return dict(edges), {n: ps for n, ps in raw_defines.items()}, dict(sym_refs)


# --- Comment / string stripper for non-Python lexical fallback ------------ #

_C_FAMILY_EXTS = frozenset({
    ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
    ".go", ".rs", ".java", ".kt", ".c", ".cc", ".cpp",
    ".h", ".hpp", ".swift", ".cs", ".php", ".scala",
})
_HASH_COMMENT_EXTS = frozenset({".rb", ".sh", ".bash", ".zsh", ".pl", ".r", ".jl"})
_TEMPLATE_LITERAL_EXTS = frozenset({".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"})


def strip_comments_and_strings(src: str, ext: str) -> str:
    """Replace comments and string-literal contents with spaces.

    Preserves byte length and newlines so downstream regexes / line numbers
    are unaffected. Single-pass state machine; approximate but safe (when in
    doubt, strips more rather than less).
    """
    ext = ext.lower()
    is_python = ext == ".py"
    use_c_block = ext in _C_FAMILY_EXTS
    use_slash_line = ext in _C_FAMILY_EXTS
    use_hash_line = is_python or ext in _HASH_COMMENT_EXTS
    use_template = ext in _TEMPLATE_LITERAL_EXTS

    out: list[str] = []
    i, n = 0, len(src)
    triple_quotes = ('"""', "'''") if is_python else ()

    while i < n:
        # Triple-quoted strings (Python)
        consumed = False
        for tq in triple_quotes:
            if src.startswith(tq, i):
                end = src.find(tq, i + 3)
                end = n if end < 0 else end + 3
                out.append(_blank(src[i:end]))
                i = end
                consumed = True
                break
        if consumed:
            continue

        # Line comments (# / //)
        if use_hash_line and src.startswith("#", i):
            nl = src.find("\n", i)
            nl = n if nl < 0 else nl
            out.append(" " * (nl - i))
            i = nl
            continue
        if use_slash_line and src.startswith("//", i):
            nl = src.find("\n", i)
            nl = n if nl < 0 else nl
            out.append(" " * (nl - i))
            i = nl
            continue

        # Block comments /* */
        if use_c_block and src.startswith("/*", i):
            end = src.find("*/", i + 2)
            end = n if end < 0 else end + 2
            out.append(_blank(src[i:end]))
            i = end
            continue

        # Quoted strings: ", ', and ` (template literals on JS/TS)
        c = src[i]
        if c in ('"', "'") or (use_template and c == "`"):
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == c:
                    j += 1
                    break
                if src[j] == "\n" and c != "`":
                    break  # unterminated single-line string
                j += 1
            out.append(_blank(src[i:j]))
            i = j
            continue

        out.append(c)
        i += 1

    return "".join(out)


def _blank(span: str) -> str:
    """Replace a span with spaces, but keep newlines so line layout is preserved."""
    return "".join(ch if ch == "\n" else " " for ch in span)


# --- TypeScript / JavaScript AST extraction (tree-sitter) ----------------- #

_TS_EXTS = (".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs")
_TS_INDEX_FILES = ("index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs")

_TS_PARSER = None
_TSX_PARSER = None
_TS_PARSER_LOADED = False


def _get_ts_parsers():
    """Return (ts_parser, tsx_parser) or (None, None) if tree-sitter isn't installed.

    Lazy + cached: first call attempts the import; subsequent calls return cached
    parsers or the cached None pair.
    """
    global _TS_PARSER, _TSX_PARSER, _TS_PARSER_LOADED
    if _TS_PARSER_LOADED:
        return _TS_PARSER, _TSX_PARSER
    _TS_PARSER_LOADED = True
    try:
        import tree_sitter  # noqa: F401
        import tree_sitter_typescript as tsts
        from tree_sitter import Language, Parser
        _TS_PARSER = Parser(Language(tsts.language_typescript()))
        _TSX_PARSER = Parser(Language(tsts.language_tsx()))
    except ImportError:
        _TS_PARSER = None
        _TSX_PARSER = None
    return _TS_PARSER, _TSX_PARSER


_PARSER_CACHE: dict[str, object] = {}
_PARSER_LOAD_FAILED: set[str] = set()


def _get_parser(grammar: str):
    """Return a tree-sitter Parser for `grammar` via tree-sitter-language-pack,
    or None if the pack / grammar isn't installed. Lazy + cached."""
    if grammar in _PARSER_CACHE:
        return _PARSER_CACHE[grammar]
    if grammar in _PARSER_LOAD_FAILED:
        return None
    try:
        from tree_sitter_language_pack import get_parser
        parser = get_parser(grammar)
    except Exception:
        _PARSER_LOAD_FAILED.add(grammar)
        return None
    _PARSER_CACHE[grammar] = parser
    return parser


def _resolve_ts_specifier(spec: str, current_file_rel: str, root: Path) -> str | None:
    """Resolve a TS module specifier to a repo-relative file path.

    Handles relative ('./x', '../x') only. Bare specifiers ('react'),
    tsconfig.json `paths` aliases ('@/components/x'), and absolute paths
    return None — accepted gap.
    """
    if not spec.startswith("."):
        return None
    current = current_file_rel.replace("\\", "/").removeprefix("./")
    base = current.rsplit("/", 1)[0] if "/" in current else ""
    raw = f"{base}/{spec}" if base else spec
    out: list[str] = []
    for p in raw.split("/"):
        if p in ("", "."):
            continue
        if p == "..":
            if out:
                out.pop()
            continue
        out.append(p)
    rel_str = "/".join(out)
    if not rel_str:
        return None
    # Explicit extension in specifier
    if any(rel_str.endswith(ext) for ext in _TS_EXTS):
        return rel_str if (root / rel_str).is_file() else None
    # Try adding each known extension
    for suf in _TS_EXTS:
        cand = rel_str + suf
        if (root / cand).is_file():
            return cand
    # Try index files inside a directory
    for idx in _TS_INDEX_FILES:
        cand = f"{rel_str}/{idx}"
        if (root / cand).is_file():
            return cand
    return None


def _ts_text(node) -> str:
    return node.text.decode("utf-8", errors="replace")


def _strip_quoted(s: str) -> str:
    if len(s) >= 2 and s[0] in ('"', "'", "`") and s[-1] == s[0]:
        return s[1:-1]
    return s


def _ts_walk_nodes(node):
    yield node
    for c in node.children:
        yield from _ts_walk_nodes(c)


def _ts_collect_skip(root_node) -> set[int]:
    """Mark identifier nodes that are *bindings* (not references), so the
    reference collector doesn't double-count import names or declaration names.

    - Inside import_statement: all identifiers are import bindings.
    - Inside export_statement with a `from` source: all identifiers are
      re-export bindings.
    - Declaration names (function/class/interface/type/enum/method) and
      variable declarator names.
    """
    skip: set[int] = set()

    def visit(node):
        nt = node.type
        if nt == "import_statement":
            for d in _ts_walk_nodes(node):
                if d.type in ("identifier", "property_identifier", "type_identifier"):
                    skip.add(d.id)
            return
        if nt == "export_statement":
            has_source = any(c.type == "string" for c in node.named_children)
            if has_source:
                for d in _ts_walk_nodes(node):
                    if d.type in ("identifier", "property_identifier", "type_identifier"):
                        skip.add(d.id)
                return
            # otherwise descend normally
        if nt in (
            "function_declaration", "class_declaration", "interface_declaration",
            "type_alias_declaration", "enum_declaration", "method_definition",
            "abstract_method_signature", "function_signature",
        ):
            name_node = node.child_by_field_name("name")
            if name_node is not None:
                skip.add(name_node.id)
        if nt == "variable_declarator":
            name_node = node.child_by_field_name("name")
            if name_node is not None and name_node.type == "identifier":
                skip.add(name_node.id)
        for child in node.children:
            visit(child)

    visit(root_node)
    return skip


def _ts_collect_refs(root_node, skip: set[int],
                     member_node: str = "member_expression") -> list[tuple[str, str | None]]:
    refs: list[tuple[str, str | None]] = []

    def visit(node):
        if node.id in skip:
            return
        nt = node.type
        if nt == member_node:
            parent = node.parent
            if parent is not None and parent.type == member_node:
                return  # handled at the outermost member chain
            cur = node
            while True:
                obj = cur.child_by_field_name("object")
                if obj is not None and obj.type == "member_expression":
                    cur = obj
                    continue
                break
            obj = cur.child_by_field_name("object")
            prop = cur.child_by_field_name("property")
            if obj is not None and obj.type == "identifier" and prop is not None:
                refs.append((_ts_text(obj), _ts_text(prop)))
                return
            # Object is a call_expression / parenthesized_expression / etc.
            # Fall through so we still capture refs inside it.
        if nt in ("identifier", "type_identifier"):
            refs.append((_ts_text(node), None))
            return
        for child in node.children:
            visit(child)

    visit(root_node)
    return refs


def _ts_record_decl(node, local_decls: dict[str, str]) -> None:
    """Record a top-level TS declaration's name into `local_decls`. Used
    for both bare top-level decls and decls wrapped in `export <decl>`."""
    nt = node.type
    if nt == "function_declaration":
        name = node.child_by_field_name("name")
        if name is not None:
            local_decls[_ts_text(name)] = "function"
    elif nt == "class_declaration":
        name = node.child_by_field_name("name")
        if name is not None:
            local_decls[_ts_text(name)] = "class"
    elif nt == "interface_declaration":
        name = node.child_by_field_name("name")
        if name is not None:
            local_decls[_ts_text(name)] = "class"
    elif nt == "type_alias_declaration":
        name = node.child_by_field_name("name")
        if name is not None:
            local_decls[_ts_text(name)] = "constant"
    elif nt == "enum_declaration":
        name = node.child_by_field_name("name")
        if name is not None:
            local_decls[_ts_text(name)] = "class"
    elif nt in ("lexical_declaration", "variable_declaration"):
        for decl in node.named_children:
            if decl.type != "variable_declarator":
                continue
            name = decl.child_by_field_name("name")
            if name is not None and name.type == "identifier":
                local_decls[_ts_text(name)] = "constant"


def _ts_decl_names(node) -> list[str]:
    """Return the names introduced by a declaration node (for export-marking)."""
    nt = node.type
    if nt in ("function_declaration", "class_declaration", "interface_declaration",
              "type_alias_declaration", "enum_declaration"):
        name = node.child_by_field_name("name")
        return [_ts_text(name)] if name is not None else []
    if nt in ("lexical_declaration", "variable_declaration"):
        out = []
        for decl in node.named_children:
            if decl.type != "variable_declarator":
                continue
            name = decl.child_by_field_name("name")
            if name is not None and name.type == "identifier":
                out.append(_ts_text(name))
        return out
    return []


def _ts_handle_top_level(
    node, local_decls, imports, star_imports, exported, alias_map, rel_norm, root,
) -> None:
    """Classify one top-level TS node. Populates declarations into
    `local_decls`, import bindings into `imports`, star re-exports into
    `star_imports`, and the set of exported names into `exported`. The
    final `defines` map is the intersection of `local_decls` and `exported`,
    computed by the caller.
    """
    nt = node.type

    if nt == "export_statement":
        source_node = next((c for c in node.named_children if c.type == "string"), None)
        if source_node is not None:
            # Re-export form: `export { X } from './y'` or `export * from './y'`
            spec = _strip_quoted(_ts_text(source_node))
            target = _resolve_ts_specifier(spec, rel_norm, root)
            export_clause = next(
                (c for c in node.named_children if c.type == "export_clause"), None,
            )
            has_star = any(_ts_text(c) == "*" for c in node.children)
            if export_clause is None and has_star:
                if target:
                    star_imports.append(target)
                return
            if export_clause is not None and target:
                for spec_node in export_clause.named_children:
                    if spec_node.type != "export_specifier":
                        continue
                    name_node = spec_node.child_by_field_name("name")
                    alias_node = spec_node.child_by_field_name("alias")
                    if name_node is None:
                        continue
                    orig = _ts_text(name_node)
                    local = _ts_text(alias_node) if alias_node is not None else orig
                    imports[local] = ImportRef(module=target, name=orig)
            return

        export_clause = next(
            (c for c in node.named_children if c.type == "export_clause"), None,
        )
        if export_clause is not None:
            # `export { X }` or `export { X as Y }` (no source) -- the names
            # were declared earlier; we just mark them exported here.
            for spec_node in export_clause.named_children:
                if spec_node.type != "export_specifier":
                    continue
                name_node = spec_node.child_by_field_name("name")
                alias_node = spec_node.child_by_field_name("alias")
                if name_node is None:
                    continue
                orig = _ts_text(name_node)
                exp = _ts_text(alias_node) if alias_node is not None else orig
                exported.add(exp)
                if alias_node is not None:
                    alias_map[exp] = orig
            return

        # `export <decl>` (incl. `export default <decl>`) -- wraps a declaration
        for ch in node.named_children:
            _ts_record_decl(ch, local_decls)
            for n in _ts_decl_names(ch):
                exported.add(n)
        return

    if nt == "import_statement":
        source_node = next((c for c in node.named_children if c.type == "string"), None)
        if source_node is None:
            return
        spec = _strip_quoted(_ts_text(source_node))
        target = _resolve_ts_specifier(spec, rel_norm, root)
        if target is None:
            return
        clause = next((c for c in node.named_children if c.type == "import_clause"), None)
        if clause is None:
            return  # side-effect import
        for ch in clause.named_children:
            ct = ch.type
            if ct == "identifier":
                imports[_ts_text(ch)] = ImportRef(module=target, name="default")
            elif ct == "namespace_import":
                ident = next((s for s in ch.named_children if s.type == "identifier"), None)
                if ident is not None:
                    imports[_ts_text(ident)] = ImportRef(module=target, name="")
            elif ct == "named_imports":
                for spec_node in ch.named_children:
                    if spec_node.type != "import_specifier":
                        continue
                    name_node = spec_node.child_by_field_name("name")
                    alias_node = spec_node.child_by_field_name("alias")
                    if name_node is None:
                        continue
                    orig = _ts_text(name_node)
                    local = _ts_text(alias_node) if alias_node is not None else orig
                    imports[local] = ImportRef(module=target, name=orig)
        return

    # Plain top-level declaration (no export) -- record locally but DON'T export
    _ts_record_decl(node, local_decls)


def parse_ts_ast(root: Path, rel: str) -> FileAst | None:
    ts_parser, tsx_parser = _get_ts_parsers()
    if ts_parser is None:
        return None
    rel_norm = rel.replace("\\", "/").removeprefix("./")
    p = root / rel_norm
    if not p.is_file():
        return None
    try:
        src = p.read_bytes()
    except OSError:
        return None
    if len(src) > 1_500_000:
        return None
    parser = tsx_parser if (rel_norm.endswith(".tsx") or rel_norm.endswith(".jsx")) else ts_parser
    tree = parser.parse(src)
    root_node = tree.root_node

    basename = rel_norm.rsplit("/", 1)[-1]
    is_package = basename in _TS_INDEX_FILES

    local_decls: dict[str, str] = {}
    imports: dict[str, ImportRef] = {}
    star_imports: list[str] = []
    exported: set[str] = set()
    alias_map: dict[str, str] = {}
    for child in root_node.named_children:
        _ts_handle_top_level(
            child, local_decls, imports, star_imports, exported, alias_map,
            rel_norm, root,
        )

    # defines = locally-declared AND exported. Names re-exported from other
    # modules via `export { X } from './y'` live in `imports` (re-export form)
    # and are picked up by build_re_exports, not by defines.
    defines: dict[str, str] = {}
    for name in exported:
        if name in local_decls:
            defines[name] = local_decls[name]
        elif name in alias_map and alias_map[name] in local_decls:
            # `export { OrigName as ExportedName }` -- expose under the export alias
            defines[name] = local_decls[alias_map[name]]

    skip = _ts_collect_skip(root_node)
    refs = _ts_collect_refs(root_node, skip)

    return FileAst(
        path=rel,
        module=rel_norm,             # for TS the module identity IS the file path
        is_package=is_package,
        defines=defines,
        imports=imports,
        star_imports=star_imports,
        references=refs,
    )


def _generic_decl_names(node) -> list[str]:
    """Names introduced by a declaration node. Handles both a direct
    child_by_field_name('name') and grouped declarations (e.g. Go
    type_declaration / const_declaration wrapping multiple specs)."""
    out: list[str] = []
    direct = node.child_by_field_name("name")
    if direct is not None:
        out.append(direct.text.decode("utf-8", "replace"))
        return out
    # Grouped: descend one level looking for *_spec nodes carrying a name.
    for ch in node.named_children:
        nm = ch.child_by_field_name("name")
        if nm is not None:
            out.append(nm.text.decode("utf-8", "replace"))
        else:
            # e.g. Go const_spec: first identifier child is the name
            for c in ch.named_children:
                if c.type in ("identifier", "type_identifier", "field_identifier"):
                    out.append(c.text.decode("utf-8", "replace"))
                    break
    return out


def _generic_collect_skip(root_node, spec) -> set[int]:
    """Mark identifier nodes that are binding sites (declaration names, import
    names) so they are not counted as references. Mirrors _ts_collect_skip but
    driven by spec.def_nodes / spec.import_node."""
    skip: set[int] = set()

    def visit(node):
        nt = node.type
        if nt == spec.import_node:
            for d in _ts_walk_nodes(node):
                if d.type.endswith("identifier"):
                    skip.add(d.id)
            return
        if nt in spec.def_nodes:
            nm = node.child_by_field_name("name")
            if nm is not None:
                skip.add(nm.id)
        for child in node.children:
            visit(child)

    visit(root_node)
    return skip


def parse_generic_ast(root: Path, rel: str, spec) -> FileAst | None:
    """Parse one source file into a FileAst using a LangSpec + tree-sitter.

    Mirrors parse_ts_ast but driven by `spec` (langspec.LangSpec) instead of
    hard-coded TS node names. Module identity == path (no package namespace).
    """
    parser = _get_parser(spec.grammar)
    if parser is None:
        return None
    rel_norm = rel.replace("\\", "/").removeprefix("./")
    p = root / rel_norm
    if not p.is_file():
        return None
    try:
        src = p.read_bytes()
    except OSError:
        return None
    if len(src) > 1_500_000:
        return None
    try:
        tree = parser.parse(src)
    except Exception:
        return None
    root_node = tree.root_node

    local_decls: dict[str, str] = {}
    imports: dict[str, ImportRef] = {}
    star_imports: list[str] = []

    # Top-level declarations and imports.
    for node in root_node.named_children:
        nt = node.type
        if nt == spec.import_node:
            for local, specifier, imported in spec.extract_imports(node):
                target = spec.resolve_import(specifier, rel_norm, root)
                if target is None:
                    continue
                imports[local] = ImportRef(module=target, name=imported)
            continue
        kind = spec.def_nodes.get(nt)
        if kind is None:
            continue
        for name in _generic_decl_names(node):
            if spec.is_exported(name):
                local_decls[name] = kind

    # References: collect identifiers + member chains, skipping binding sites.
    skip = _generic_collect_skip(root_node, spec)
    references = _ts_collect_refs(root_node, skip, member_node=spec.member_node)

    return FileAst(
        path=rel_norm,
        module=rel_norm,                 # path identity
        is_package=False,
        defines=local_decls,
        imports=imports,
        star_imports=star_imports,
        references=references,
    )


def build_typescript_graph(
    root: Path,
    ts_files: list[str],
) -> tuple[dict[tuple[str, str], int], dict[str, set[str]], dict[str, int]]:
    """Mirror of build_python_graph for TS/JS/TSX/JSX files.

    Module identity for TS is the file path itself, so the module_index is just
    {path: path}. Otherwise the attribution flow is identical: locally defined →
    skip, imported → resolve (with re-export chase via index.ts barrels), star
    re-export → first hit, no global single-definer fallback.
    """
    asts: dict[str, FileAst] = {}
    for rel in ts_files:
        fa = parse_ts_ast(root, rel)
        if fa is not None:
            asts[fa.path] = fa
    return build_ast_graph_from_asts(asts)


def build_ast_graph_from_asts(
    asts: dict[str, FileAst],
) -> tuple[dict[tuple[str, str], int], dict[str, set[str]], dict[str, int]]:
    """Language-agnostic attribution over a set of parsed FileAsts.

    Lifted from build_typescript_graph: module_index, re_exports, raw_defines
    (with the len>=4 / class filter), then the per-reference attribution loop
    via _attribute_ref. Shared by TS and the generic tree-sitter tier.
    """
    module_index = {fa.module: fa.path for fa in asts.values()}
    re_exports = build_re_exports(asts, module_index)

    raw_defines: dict[str, set[str]] = defaultdict(set)
    for fa in asts.values():
        for name, kind in fa.defines.items():
            if kind != "class" and len(name) < 4:
                continue
            raw_defines[name].add(fa.path)

    edges: dict[tuple[str, str], int] = defaultdict(int)
    sym_refs: dict[str, int] = defaultdict(int)
    for fa in asts.values():
        seen: set[tuple[str, str]] = set()
        for top, attr in fa.references:
            hit = _attribute_ref(fa, top, attr, asts, module_index, re_exports)
            if hit is None:
                continue
            dst, resolved_name = hit
            if not dst or dst == fa.path:
                continue
            edge = (fa.path, dst)
            if edge in seen:
                continue
            seen.add(edge)
            edges[edge] += 1
            sym_refs[resolved_name] += 1

    return dict(edges), dict(raw_defines), dict(sym_refs)


def build_generic_graph(
    root: Path,
    files: list[str],
    spec,
) -> tuple[dict[tuple[str, str], int], dict[str, set[str]], dict[str, int]]:
    """Build the AST graph for `files` of one generic language via `spec`."""
    asts: dict[str, FileAst] = {}
    for rel in files:
        fa = parse_generic_ast(root, rel, spec)
        if fa is not None:
            asts[fa.path] = fa
    return build_ast_graph_from_asts(asts)


# --- Non-Python lexical graph (with stripping) ---------------------------- #

def _build_nonpython_graph(
    root: Path,
    tags: list[dict],
    used_by_ast: set[str],
) -> tuple[dict[tuple[str, str], int], dict[str, set[str]], dict[str, int]]:
    """Same shape as v1's build_reference_graph but pre-strips comments/strings
    and considers only files NOT already handled by an AST extractor."""
    raw_defines: dict[str, set[str]] = defaultdict(set)
    for t in tags:
        path = t.get("path", "")
        if path in used_by_ast or not path:
            continue
        kind = t.get("kind")
        name = t.get("name", "")
        if kind not in {"function", "class", "method"}:
            continue
        if not name or name.startswith("_"):
            continue
        if kind != "class" and len(name) < 4:
            continue
        scope = t.get("scope", "")
        scope_kind = t.get("scopeKind", "")
        if scope and scope_kind not in {"", "class"}:
            continue
        raw_defines[name].add(path)
    defines = {n: ps for n, ps in raw_defines.items() if len(ps) == 1}

    files = sorted(
        {t["path"] for t in tags if "path" in t and t["path"] not in used_by_ast}
    )
    edges: dict[tuple[str, str], int] = defaultdict(int)
    sym_refs: dict[str, int] = defaultdict(int)
    for src in files:
        body = safe_read(root, src)
        if not body:
            continue
        ext = "." + src.rsplit(".", 1)[-1] if "." in src else ""
        body = strip_comments_and_strings(body, ext)
        tokens = set(WORD_RE.findall(body))
        for tok in tokens:
            if tok not in defines:
                continue
            for dst in defines[tok]:
                if dst == src:
                    continue
                edges[(src, dst)] += 1
                sym_refs[tok] += 1
    return dict(edges), {n: ps.copy() for n, ps in raw_defines.items()}, dict(sym_refs)


# --- Unified v2 builder --------------------------------------------------- #

_TS_FILE_EXTS = frozenset({".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"})


def build_graph_v2(
    root: Path,
    tags: list[dict],
) -> tuple[list[str], dict[tuple[str, str], int], dict[str, set[str]], dict[str, int]]:
    """Combined graph: AST for .py and TS-family (when tree-sitter is
    available), comment-stripped lexical for everything else."""
    all_files = sorted({t["path"] for t in tags if "path" in t})
    py_files = [p for p in all_files if p.endswith(".py")]
    ts_files = [p for p in all_files
                if any(p.endswith(ext) for ext in _TS_FILE_EXTS)]

    used_by_ast: set[str] = set(py_files)
    py_edges, py_defines, py_sym_refs = build_python_graph(root, py_files)

    ts_parser, _ = _get_ts_parsers()
    if ts_parser is not None and ts_files:
        ts_edges, ts_defines, ts_sym_refs = build_typescript_graph(root, ts_files)
        used_by_ast.update(ts_files)
    else:
        ts_edges, ts_defines, ts_sym_refs = {}, {}, {}

    # Generic tree-sitter tier: dispatch registered languages whose grammar is
    # installed. Uninstalled grammars fall through to the lexical tier below.
    from langspec import LANG_SPECS
    generic_results = []
    seen_specs: set[int] = set()
    for ext, spec in LANG_SPECS.items():
        if id(spec) in seen_specs:
            continue
        seen_specs.add(id(spec))
        spec_files = [p for p in all_files
                      if any(p.endswith(e) for e in spec.exts)
                      and p not in used_by_ast]
        if not spec_files:
            continue
        if _get_parser(spec.grammar) is None:
            continue  # grammar not installed -> fall through to lexical tier
        g_edges, g_defines, g_sym_refs = build_generic_graph(root, spec_files, spec)
        used_by_ast.update(spec_files)
        generic_results.append((g_edges, g_defines, g_sym_refs))

    nx_edges, nx_defines, nx_sym_refs = _build_nonpython_graph(root, tags, used_by_ast)

    edges: dict[tuple[str, str], int] = defaultdict(int)
    for src_edges in (py_edges, ts_edges, nx_edges):
        for e, w in src_edges.items():
            edges[e] += w

    defines: dict[str, set[str]] = defaultdict(set)
    for src_def in (py_defines, ts_defines, nx_defines):
        for n, ps in src_def.items():
            defines[n].update(ps)

    sym_refs: dict[str, int] = defaultdict(int)
    for src_sr in (py_sym_refs, ts_sym_refs, nx_sym_refs):
        for n, c in src_sr.items():
            sym_refs[n] += c

    for g_edges, g_defines, g_sym_refs in generic_results:
        for e, w in g_edges.items():
            edges[e] += w
        for n, ps in g_defines.items():
            defines[n].update(ps)
        for n, c in g_sym_refs.items():
            sym_refs[n] += c

    return all_files, dict(edges), dict(defines), dict(sym_refs)


# --- Entry-point detection ------------------------------------------------ #

# Python module-level patterns. Each must match top-of-line (multiline mode).
_PY_ENTRY_PATTERNS = (
    re.compile(r'^if\s+__name__\s*==\s*[\'"]__main__[\'"]\s*:', re.M),
    re.compile(r'^(?:async\s+)?def\s+main\s*\(', re.M),
    re.compile(
        r'^[A-Za-z_]\w*\s*=\s*'
        r'(?:FastAPI|Flask|Bottle|Sanic|Quart|Starlette|application|Application)\s*\(',
        re.M,
    ),
)
# TS / JS module-level patterns. Many real-world CLIs do not use
# `export default function`; they have a shebang + top-level call expressions
# instead.
_TS_ENTRY_PATTERNS = (
    re.compile(r'^export\s+default\s+(?:async\s+)?function\b', re.M),
    # Shebang on the very first line, naming a JS-family runtime
    re.compile(r'\A#!.*\b(?:node|deno|bun|tsx|ts-node)\b'),
    # Runtime guards: `if (require.main === module) {}` / `if (import.meta.main)`
    re.compile(r'^if\s*\(\s*require\.main\s*===\s*module', re.M),
    re.compile(r'^if\s*\(\s*import\.meta\.main\b', re.M),
    # Top-level access to process.argv (column 0)
    re.compile(r'^process\.argv\b', re.M),
    # Top-level `const args = process.argv.slice(...)` style
    re.compile(r'^(?:const|let|var)\s+\w+\s*=.*process\.argv', re.M),
    # Top-level call expression `main(...)` or `await main(...)` -- when the
    # line starts with `main(` (column 0), the call is at module scope rather
    # than inside a function body.
    re.compile(r'^(?:await\s+)?main\s*\(', re.M),
)


def _file_is_entry_point(root: Path, rel: str) -> bool:
    """Heuristic check: does this file look like a program entry point?"""
    rel_norm = rel.replace("\\", "/").removeprefix("./")
    src = safe_read(root, rel_norm)
    if not src:
        return False
    if rel_norm.endswith(".py"):
        return any(p.search(src) for p in _PY_ENTRY_PATTERNS)
    if rel_norm.endswith((".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")):
        return any(p.search(src) for p in _TS_ENTRY_PATTERNS)
    from langspec import LANG_SPECS
    ext = "." + rel_norm.rsplit(".", 1)[-1] if "." in rel_norm else ""
    spec = LANG_SPECS.get(ext)
    if spec is not None and spec.entry_patterns:
        return any(p.search(src) for p in spec.entry_patterns)
    return False


def _candidate_source_paths(p: str) -> list[str]:
    """Given a build-artifact path like 'dist/cli.js' return the set of
    source-file paths it might correspond to.

    Two transformations:
      - Extension swap: .js / .cjs / .mjs  ->  .ts / .tsx / .mts / .cts
      - Build-dir strip: dist/X / lib/X / build/X / out/X  ->  X  /  src/X

    Both transformations are tried independently and combined. The original
    path is included so a literal source match still works.
    """
    p = p.replace("\\", "/")
    out: list[str] = [p]
    _SRC_EXTS = ("ts", "tsx", "mts", "cts")
    base, sep, ext = p.rpartition(".")
    if sep == "." and ext in ("js", "cjs", "mjs"):
        for new_ext in _SRC_EXTS:
            out.append(f"{base}.{new_ext}")
    for prefix in ("dist/", "lib/", "build/", "out/"):
        if p.startswith(prefix):
            stripped = p[len(prefix):]
            out.append(stripped)
            out.append(f"src/{stripped}")
            base2, sep2, ext2 = stripped.rpartition(".")
            if sep2 == "." and ext2 in ("js", "cjs", "mjs"):
                for new_ext in _SRC_EXTS:
                    out.append(f"{base2}.{new_ext}")
                    out.append(f"src/{base2}.{new_ext}")
    return out


def _package_json_entries(root: Path, files: list[str]) -> set[str]:
    """Pull `main` and `bin` paths out of every package.json in the workspace
    and map them back to entries in `files`. Walks all package.json files
    (not just the root) so monorepo workspace packages are covered. For each
    declared path, also tries dist->src and .js->.ts rewrites so that
    `bin: dist/cli.js` resolves to `src/cli.ts` when only the source exists.
    """
    out: set[str] = set()
    file_norm = {f.replace("\\", "/").removeprefix("./"): f for f in files}

    skip_dirs = {
        ".git", "node_modules", ".venv", "venv", "dist", "build", "out",
        "target", "__pycache__", ".turbo", ".cache", ".next", ".nuxt",
    }
    for pkg_json in root.rglob("package.json"):
        if any(part in skip_dirs for part in pkg_json.parts):
            continue
        try:
            data = json.loads(pkg_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        candidates: list[str] = []
        if isinstance(data.get("main"), str):
            candidates.append(data["main"])
        bin_field = data.get("bin")
        if isinstance(bin_field, str):
            candidates.append(bin_field)
        elif isinstance(bin_field, dict):
            candidates.extend(v for v in bin_field.values() if isinstance(v, str))
        if not candidates:
            continue

        try:
            rel_dir = pkg_json.parent.relative_to(root)
        except ValueError:
            continue
        pkg_dir_str = "" if str(rel_dir) == "." else str(rel_dir).replace("\\", "/")

        for c in candidates:
            c_norm = c.replace("\\", "/").lstrip("./")
            for cand in _candidate_source_paths(c_norm):
                full = f"{pkg_dir_str}/{cand}" if pkg_dir_str else cand
                if full in file_norm:
                    out.add(file_norm[full])
    return out


def _entry_walk_exts() -> tuple[str, ...]:
    """Extensions the entry-point walk visits: the built-in Python/TS set plus
    every extension registered in the generic tree-sitter tier."""
    from langspec import LANG_SPECS
    return tuple({".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
                  *LANG_SPECS.keys()})


_ENTRY_WALK_EXTS = _entry_walk_exts()
_ENTRY_WALK_SKIP = frozenset({
    ".git", "node_modules", ".venv", "venv", "dist", "build", "out",
    "target", "__pycache__", ".turbo", ".cache", ".next", ".nuxt",
    ".pytest_cache", ".mypy_cache", ".ruff_cache",
})


def detect_entry_points(root: Path, files: list[str]) -> set[str]:
    """Return the set of paths that look like program entry points.

    Combines source-file heuristics (Python `__main__` block, `def main(`,
    `app = FastAPI()`; TS shebang, top-level `main(` call, runtime guards)
    with package.json metadata (`main` field, `bin` map values).

    Walks the source tree directly rather than iterating `files`. Some real
    entry points (a CLI bootstrap with imports + a single top-level call)
    have zero ctags declarations and are absent from the tags-derived file
    list. The walk catches them.

    Returned paths use the same form as `files` when the path is also in
    `files` (preserving any leading './'); otherwise paths are repo-relative
    POSIX-style without prefix.
    """
    file_norm = {f.replace("\\", "/").removeprefix("./"): f for f in files}
    out: set[str] = set()

    def add(rel_norm: str) -> None:
        # Preserve the original './'-prefixed form when the file is in the
        # tags-derived file list. For glob-walked files that aren't in tags
        # (thin entry-points with no symbols), use './'-prefix to match the
        # atlas's canonical path form so folder-bucket [entry] tags fire.
        if rel_norm in file_norm:
            out.add(file_norm[rel_norm])
        else:
            out.add(f"./{rel_norm}")

    for current_root, dirs, fnames in os.walk(root):
        dirs[:] = [
            d for d in dirs
            if d == ".pi" or (d not in _ENTRY_WALK_SKIP and not d.startswith("."))
        ]
        for fname in fnames:
            if not fname.endswith(_ENTRY_WALK_EXTS):
                continue
            full = Path(current_root) / fname
            try:
                rel = full.relative_to(root)
            except ValueError:
                continue
            rel_norm = str(rel).replace("\\", "/")
            if _file_is_entry_point(root, rel_norm):
                add(rel_norm)

    for rel in _package_json_entries(root, files):
        add(rel.replace("\\", "/").removeprefix("./"))
    return out


# --- Folder-to-folder graph (rendered at top of grand atlas) -------------- #

def aggregate_folder_graph(
    edges: dict[tuple[str, str], int],
    bucket_for_file: dict[str, str],
) -> list[tuple[str, list[tuple[str, int]]]]:
    """Aggregate file-level edges into folder-to-folder edges.

    `bucket_for_file` maps each file path to its atlas folder bucket. Edges
    where both endpoints map to the same bucket are dropped (no self-loops).
    Files without a bucket are skipped (their edges contribute nothing).

    Returns: [(src_folder, [(dst_folder, weight), ...]), ...] sorted by total
    outbound weight descending. Within each src, destinations are sorted by
    weight descending.
    """
    folder_edges: dict[tuple[str, str], int] = defaultdict(int)
    for (src, dst), w in edges.items():
        sb = bucket_for_file.get(src)
        db = bucket_for_file.get(dst)
        if sb is None or db is None or sb == db:
            continue
        folder_edges[(sb, db)] += w

    by_src: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for (sb, db), w in folder_edges.items():
        by_src[sb].append((db, w))
    for sb in by_src:
        by_src[sb].sort(key=lambda kv: -kv[1])

    return sorted(
        by_src.items(),
        key=lambda kv: -sum(w for _, w in kv[1]),
    )


def render_folder_graph(
    folder_edges: list[tuple[str, list[tuple[str, int]]]],
    max_lines: int = 6,
    max_neighbors: int = 4,
) -> str:
    """Compact `## Folder graph` markdown block.

    Format: one line per source folder, listing the top destinations with a
    `+N` truncation suffix when there are more. Empty graph -> empty string
    (caller skips emission).
    """
    if not folder_edges:
        return ""
    lines = ["## Folder graph", ""]
    for src, dsts in folder_edges[:max_lines]:
        shown = dsts[:max_neighbors]
        extra = len(dsts) - len(shown)
        names = ", ".join(d for d, _ in shown)
        if extra > 0:
            names += ", +" + str(extra)
        lines.append(f"- `{src}/` → {names}")
    lines.append("")
    return "\n".join(lines)


# --- Diff helper (used by `--graph-builder both`) ------------------------- #

def diff_graphs(
    lex_edges: dict[tuple[str, str], int],
    ast_edges: dict[tuple[str, str], int],
    lex_pr: dict[str, float],
    ast_pr: dict[str, float],
) -> str:
    lex_set = set(lex_edges)
    ast_set = set(ast_edges)
    added = ast_set - lex_set
    removed = lex_set - ast_set
    top_lex = sorted(lex_pr.items(), key=lambda kv: -kv[1])[:10]
    top_ast = sorted(ast_pr.items(), key=lambda kv: -kv[1])[:10]
    churn = sum(1 for f, _ in top_lex if f not in {x for x, _ in top_ast})
    lines = [
        f"edges:  lexical={len(lex_set)}  ast={len(ast_set)}  "
        f"+{len(added)}  -{len(removed)}",
        f"top-10 rank churn: {churn} files changed",
        "top-10 lexical:",
    ]
    lines += [f"  {f}  ({pct:.2f}%)" for f, pct in top_lex]
    lines.append("top-10 ast:")
    lines += [f"  {f}  ({pct:.2f}%)" for f, pct in top_ast]
    return "\n".join(lines)



# 10. ModuleItem construction
# --------------------------------------------------------------------------- #
def build_module_items(
    funcs_by_file, sym_refs, pr_pct, facts_by_file, classes_by_file,
    entry_points: set[str] | None = None,
) -> list[ModuleItem]:
    entry_points = entry_points or set()
    items: list[ModuleItem] = []
    for path, funcs in funcs_by_file.items():
        if is_test_path(path):
            continue
        facts = facts_by_file.get(path, {"docstring": "", "constants": [], "classes": {}, "has_routes": False})
        ast_classes = facts.get("classes", {})
        tag_classes = classes_by_file.get(path, [])
        public = sorted((n for n in funcs if not n.startswith("_")),
                        key=lambda n: (-sym_refs.get(n, 0), n))
        if not public and not facts.get("docstring") and not ast_classes and not tag_classes:
            continue
        docstring = facts.get("docstring", "")
        pr = pr_pct.get(path, 0.0)
        n_public = len(public)

        ent_inline = " [entry]" if path in entry_points else ""
        ent_dot = " \u00b7 [entry]" if path in entry_points else ""

        L0 = f"- `{path}`{ent_inline}"
        L1 = f"- `{path}` \u00b7 {n_public} public \u00b7 PR {pr:.1f}%{ent_dot}"

        l2 = [f"### `{path}` \u00b7 PR {pr:.1f}%{ent_dot}"]
        if docstring:
            l2.append(f"> {docstring}")
        if public:
            l2.append("Public: " + ", ".join(f"`{p}`" for p in public[:8]))
        L2 = "\n".join(l2)

        l3 = [f"### `{path}` \u00b7 PR {pr:.1f}%{ent_dot}"]
        if docstring:
            l3.append(f"> {docstring}")
        if ast_classes:
            for cls, fields in list(ast_classes.items())[:8]:
                shown = ", ".join(f"{fn}: {ty}" if ty else fn for fn, ty in fields[:8])
                l3.append(f"- class `{cls}({shown})`")
        elif tag_classes:
            l3.append("Classes: " + ", ".join(f"`{c}`" for c in tag_classes[:6]))
        consts = facts.get("constants", [])
        if consts:
            l3.append("Constants: " + ", ".join(f"`{n}={v}`" for n, v in consts[:6]))
        if public:
            extra = n_public - 20
            shown = ", ".join(f"`{p}`" for p in public[:20])
            l3.append(f"Public: {shown}" + (f", +{extra}" if extra > 0 else ""))
        L3 = "\n".join(l3)

        score = pr + 0.01
        if facts.get("has_routes"):
            score *= 1.5
        if docstring:
            score *= 1.1

        items.append(ModuleItem(path, score, pr, n_public, L0, L1, L2, L3))

    items.sort(key=lambda it: -it.score)
    return items


# --------------------------------------------------------------------------- #
# 11. Greedy detail allocation
# --------------------------------------------------------------------------- #
def allocate(items, budget):
    selected = {}
    remaining = budget
    for it in items:
        for level in (3, 2, 1, 0):
            text = it.render(level)
            cost = count_tokens(text) + 2
            if cost <= remaining:
                selected[it.path] = (level, text)
                remaining -= cost
                break
    return selected


# --------------------------------------------------------------------------- #
# 12. Atlas folder bucketing
# --------------------------------------------------------------------------- #
def _file_folder(path: str, depth: int) -> str:
    rel = path.removeprefix("./")
    parts = rel.split("/")
    if len(parts) <= depth:
        return "/".join(parts[:-1]) or "."
    return "/".join(parts[:depth])


def build_atlas_buckets(items, pr_pct, atlas_budget,
                        min_files_to_expand=6,
                        per_bucket_token_estimate=110):
    sources = [it.path for it in items]
    if not sources:
        return []
    depth_by_path = {p: 1 for p in sources}

    def buckets():
        out = defaultdict(list)
        for p in sources:
            out[_file_folder(p, depth_by_path[p])].append(p)
        return out

    unsplittable = set()
    while True:
        cur = buckets()
        cost = len(cur) * per_bucket_token_estimate
        if cost > atlas_budget:
            break
        candidates = [
            (prefix, paths) for prefix, paths in cur.items()
            if len(paths) >= min_files_to_expand and prefix not in unsplittable
        ]
        if not candidates:
            break
        candidates.sort(key=lambda kv: -len(kv[1]))
        target_prefix, target_paths = candidates[0]
        target_depth = depth_by_path[target_paths[0]]
        for p in target_paths:
            depth_by_path[p] = target_depth + 1
        new_buckets = buckets()
        new_for_target = [
            paths for prefix, paths in new_buckets.items()
            if set(paths).issubset(set(target_paths))
        ]
        if len(new_for_target) == 1:
            for p in target_paths:
                depth_by_path[p] = target_depth
            unsplittable.add(target_prefix)
            continue
        new_cost = len(new_buckets) * per_bucket_token_estimate
        if new_cost > atlas_budget:
            for p in target_paths:
                depth_by_path[p] = target_depth
            break

    final = buckets()
    out = []
    for prefix, paths in final.items():
        pr = sum(pr_pct.get(p, 0.0) for p in paths)
        out.append(FolderBucket(prefix=prefix, files=sorted(paths), pr_pct=pr))
    out.sort(key=lambda b: -b.pr_pct)
    return out


# --------------------------------------------------------------------------- #
# 13. Atlas rendering
# --------------------------------------------------------------------------- #
def render_atlas(
    buckets, items, sym_refs, defines, routes_by_file,
    entry_points: set[str] | None = None,
    folder_edges: list[tuple[str, list[tuple[str, int]]]] | None = None,
) -> list[str]:
    by_path = {it.path: it for it in items}
    entry_points = entry_points or set()
    out: list[str] = []
    if folder_edges:
        block = render_folder_graph(folder_edges)
        if block:
            out.append(block)
    out.append("## Folder atlas\n")
    out.append(
        "_Folder roll-ups ranked by aggregate PageRank. "
        "To drill in, request `--mode zoom --scope <prefix>`._\n"
    )
    for b in buckets:
        item_paths = set(b.files)
        local_syms = {
            sym for sym, paths in defines.items()
            if any(p in item_paths for p in paths) and sym not in NOISE_NAMES
        }
        ranked = sorted(local_syms, key=lambda s: (-sym_refs.get(s, 0), s))[:5]
        modules = []
        seen_mod = set()
        for p in b.files:
            stem = Path(p).stem
            if stem not in seen_mod:
                seen_mod.add(stem)
                modules.append(stem)
            if len(modules) >= 6:
                break
        routes = []
        for p in b.files:
            for (method, rpath, _handler) in routes_by_file.get(p, []):
                routes.append(f"{method} {rpath}")
            if len(routes) >= 4:
                break
        routes = routes[:4]

        # Folder has [entry] if any entry-point file lives under its prefix.
        prefix_with_slash = b.prefix.rstrip("/") + "/"
        bucket_prefix = b.prefix.rstrip("/")
        has_entry = any(
            (e_norm := e.replace("\\", "/").removeprefix("./")) == bucket_prefix
            or e_norm.startswith(prefix_with_slash)
            for e in entry_points
        )
        entry_tag = "  \u00b7  [entry]" if has_entry else ""

        out.append(f"### `{b.prefix}/`  \u00b7  {len(b.files)} files  \u00b7  "
                 f"PR {b.pr_pct:.1f}%{entry_tag}")
        detail = []
        if modules:
            detail.append("mods " + " ".join(f"`{m}`" for m in modules))
        if ranked:
            detail.append("syms " + " ".join(f"`{s}`" for s in ranked))
        if routes:
            detail.append("routes " + " ".join(f"`{r}`" for r in routes))
        if detail:
            out.append(" \u00b7 ".join(detail))
        out.append(f"- drill: `--mode zoom --scope {b.prefix}`")
    return out


# --------------------------------------------------------------------------- #
# 14. Header
# --------------------------------------------------------------------------- #
def render_header(root: Path, mode: str, scope: str | None) -> list[str]:
    title = f"# Codebase vocabulary: {root.name} ({mode}"
    if scope:
        title += f" · scope `{scope}/`"
    title += ")"
    out = [title, "", "_Auto-generated. Read before searching for unfamiliar concepts._", ""]
    meta = project_metadata(root)
    if meta:
        out.append("## Project")
        for m in meta:
            out.append(f"- {m}")
        out.append("")
    return out


# --------------------------------------------------------------------------- #
# 23. Orchestration
# --------------------------------------------------------------------------- #
def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--root", default=".", help="Repo root to operate on.")
    parser.add_argument("--tags", default=None,
                        help="Path to tags.json (default: <root>/tags.json).")
    parser.add_argument(
        "--mode",
        choices=["grand", "zoom", "full", "atlas", "section"],
        default="full",
        help="Output mode. 'grand' (was 'atlas') = folder roll-ups, the auto-attached "
             "first-read view. 'zoom' (was 'section') = per-file detail at --scope. "
             "'full' = per-file detail across the whole repo. 'atlas' / 'section' "
             "are kept as aliases for one cycle.",
    )
    parser.add_argument("--scope", default=None,
                        help="Required for zoom mode; relative folder.")
    parser.add_argument("--tokens-per-file", type=int, default=80,
                        help="Average tokens budgeted per source file (default 80).")
    parser.add_argument("--budget", type=int, default=None,
                        help="Override total module-section budget in tokens.")
    parser.add_argument("--atlas-budget", type=int, default=2000,
                        help="Token cap for atlas mode (default 2000).")
    parser.add_argument("--graph-builder", choices=["ast", "lexical", "both"],
                        default="ast",
                        help="Reference graph builder. 'ast' (default) is the v2 "
                             "AST-driven path for Python + comment-stripped lexical "
                             "for other languages. 'lexical' is the v1 fallback. "
                             "'both' builds both and prints a diff to stderr (uses ast for output).")
    parser.add_argument("--out", default=None,
                        help="Output path (default: <root>/vocabulary.md).")
    args = parser.parse_args()

    # Mode aliases (one-cycle backwards compat).
    _MODE_ALIASES = {"atlas": "grand", "section": "zoom"}
    args.mode = _MODE_ALIASES.get(args.mode, args.mode)

    root = Path(args.root).resolve()
    tags_path = Path(args.tags) if args.tags else root / "tags.json"
    out_path = Path(args.out) if args.out else root / "vocabulary.md"

    tags = load_tags(tags_path)

    classes_by_file: dict[str, list[str]] = defaultdict(list)
    for t in tags:
        if t.get("kind") == "class":
            classes_by_file[t["path"]].append(t["name"])

    funcs_by_file: dict[str, list[str]] = defaultdict(list)
    for t in tags:
        if t.get("kind") in {"function", "method"}:
            funcs_by_file[t["path"]].append(t["name"])

    if args.graph_builder == "both":
        f_l, e_l, _, _, pr_l = build_graph_cached(root, tags_path, tags, builder="lexical")
        files, edges, defines, sym_refs, pr = build_graph_cached(root, tags_path, tags, builder="ast")
        tot_l = sum(pr_l.values()) or 1.0
        tot_a = sum(pr.values()) or 1.0
        pct_l = {f: 100.0 * pr_l.get(f, 0.0) / tot_l for f in f_l}
        pct_a = {f: 100.0 * pr.get(f, 0.0) / tot_a for f in files}
        print(diff_graphs(e_l, edges, pct_l, pct_a), file=sys.stderr)
    else:
        files, edges, defines, sym_refs, pr = build_graph_cached(
            root, tags_path, tags, builder=args.graph_builder,
        )
    pr_total = sum(pr.values()) or 1.0
    pr_pct = {f: 100.0 * pr.get(f, 0.0) / pr_total for f in files}

    facts_by_file: dict[str, dict] = {}
    for path in funcs_by_file:
        facts_by_file[path] = extract_facts(root, path)

    entry_points = detect_entry_points(root, files)

    # Persist entry points alongside the graph cache so vocab_find can read
    # them without re-scanning source files. We update the cache file in
    # place; on cache miss the next build_graph_cached call will overwrite.
    try:
        cache_path = tags_path.with_suffix(tags_path.suffix + ".cache")
        if cache_path.is_file():
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            cached["entry_points"] = sorted(entry_points)
            cache_path.write_text(json.dumps(cached), encoding="utf-8")
    except (OSError, json.JSONDecodeError):
        pass

    items_all = build_module_items(
        funcs_by_file, sym_refs, pr_pct, facts_by_file, classes_by_file,
        entry_points=entry_points,
    )

    raw_routes = extract_routes(root, list(funcs_by_file.keys()))
    routes_by_file: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    for method, path, handler, file in raw_routes:
        routes_by_file[file].append((method, path, handler))

    out: list[str] = render_header(root, args.mode, args.scope)

    if args.mode == "grand":
        buckets = build_atlas_buckets(items_all, pr_pct, args.atlas_budget)
        bucket_for_file = {p: b.prefix for b in buckets for p in b.files}
        folder_edges = aggregate_folder_graph(edges, bucket_for_file)
        out += render_atlas(
            buckets, items_all, sym_refs, defines, routes_by_file,
            entry_points=entry_points,
            folder_edges=folder_edges,
        )
    else:
        items = items_all
        if args.mode == "zoom":
            if not args.scope:
                raise SystemExit("--scope is required when --mode zoom")
            scope_prefix = args.scope.rstrip("/")
            def in_scope(p: str) -> bool:
                rel = p.removeprefix("./")
                return rel.startswith(scope_prefix + "/") or rel == scope_prefix
            items = [it for it in items_all if in_scope(it.path)]
            if not items:
                raise SystemExit(f"no source files under scope: {args.scope}")
            local_total = sum(it.pr_pct for it in items) or 1.0
            for it in items:
                it.pr_pct = 100.0 * it.pr_pct / local_total

        if raw_routes and args.mode == "full":
            out.append("## HTTP routes (FastAPI)")
            for method, path, handler, _file in raw_routes:
                out.append(f"- `{method:<6} {path}` \u2192 `{handler}`")
            out.append("")

        if args.mode == "full":
            if gloss := extract_glossary(root):
                out.append("## Domain notes (from README)")
                for term, desc in gloss:
                    out.append(f"- **{term}** \u2014 {desc}")
                out.append("")
            if tree := folder_tree(root):
                out.append("## Folder structure")
                out.extend(tree)
                out.append("")

        n_source = len(items)
        budget = args.budget if args.budget is not None else args.tokens_per_file * n_source
        selected = allocate(items, budget)

        header = "## Modules"
        if args.mode == "zoom":
            header += f" in `{args.scope}/`"
        header += (
            f"  \u00b7  budget: {budget} tok = "
            f"{args.tokens_per_file} \u00d7 {n_source} files"
        )
        out.append(header)
        out.append("_Greedy detail allocation: L3 full \u2192 L2 summary \u2192 L1 brief \u2192 L0 listed._\n")

        by_level = defaultdict(list)
        for it in items:
            sel = selected.get(it.path)
            if sel is None:
                continue
            level, text = sel
            by_level[level].append((it, text))
        titles = {3: "L3 \u2014 Top (full)", 2: "L2 \u2014 Summary",
                  1: "L1 \u2014 Brief", 0: "L0 \u2014 Listed"}
        for level in (3, 2, 1, 0):
            if level not in by_level:
                continue
            out.append(f"### {titles[level]}")
            for _it, text in by_level[level]:
                out.append(text)
                if level >= 2:
                    out.append("")
            out.append("")

    text = "\n".join(out)
    out_path.write_text(text, encoding="utf-8")
    total = count_tokens(text)
    try:
        rel = out_path.relative_to(root)
    except ValueError:
        rel = out_path
    print(f"Wrote {rel}: {total} tok (mode={args.mode}, files indexed={len(files)})")


if __name__ == "__main__":
    main()
