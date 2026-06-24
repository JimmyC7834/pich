"""Tests for TypeScript/JavaScript AST graph builder (tree-sitter optional).

All tests are skipped if tree-sitter is not installed.
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import tree_sitter  # noqa: F401
    import tree_sitter_typescript  # noqa: F401
    HAS_TS = True
except ImportError:
    HAS_TS = False

from make_vocab import (
    parse_ts_ast, build_typescript_graph, build_graph_v2,
    _resolve_ts_specifier, FileAst,
)


def _write_file(root: Path, rel: str, content: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


@unittest.skipIf(not HAS_TS, "tree-sitter not installed")
class TestResolveTsSpecifier(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.root))

    def test_relative_ts(self):
        _write_file(self.root, "a.ts", "")
        _write_file(self.root, "b.ts", "")
        result = _resolve_ts_specifier("./b", "a.ts", self.root)
        self.assertEqual(result, "b.ts")

    def test_relative_tsx(self):
        _write_file(self.root, "a.ts", "")
        _write_file(self.root, "b.tsx", "")
        result = _resolve_ts_specifier("./b", "a.ts", self.root)
        self.assertEqual(result, "b.tsx")

    def test_index_file(self):
        _write_file(self.root, "mod/index.ts", "")
        result = _resolve_ts_specifier("./mod", "a.ts", self.root)
        self.assertEqual(result, "mod/index.ts")

    def test_parent_dir(self):
        _write_file(self.root, "src/a.ts", "")
        _write_file(self.root, "b.ts", "")
        result = _resolve_ts_specifier("../b", "src/a.ts", self.root)
        self.assertEqual(result, "b.ts")

    def test_bare_specifier_returns_none(self):
        result = _resolve_ts_specifier("react", "a.ts", self.root)
        self.assertIsNone(result)

    def test_unresolvable_returns_none(self):
        result = _resolve_ts_specifier("./nonexistent", "a.ts", self.root)
        self.assertIsNone(result)

    def test_explicit_extension(self):
        _write_file(self.root, "a.js", "")
        result = _resolve_ts_specifier("./a.js", "b.ts", self.root)
        self.assertEqual(result, "a.js")


@unittest.skipIf(not HAS_TS, "tree-sitter not installed")
class TestParseTsAst(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.root))

    def test_named_import(self):
        _write_file(self.root, "utils.ts", "export const helper = 1")
        _write_file(self.root, "main.ts", 'import { helper } from "./utils"')
        fa = parse_ts_ast(self.root, "main.ts")
        self.assertIsNotNone(fa)
        self.assertIn("helper", fa.imports)
        self.assertEqual(fa.imports["helper"].name, "helper")

    def test_default_import(self):
        _write_file(self.root, "utils.ts", "export default 42")
        _write_file(self.root, "main.ts", 'import val from "./utils"')
        fa = parse_ts_ast(self.root, "main.ts")
        self.assertIsNotNone(fa)
        self.assertIn("val", fa.imports)
        self.assertEqual(fa.imports["val"].name, "default")

    def test_namespace_import(self):
        _write_file(self.root, "utils.ts", "export const a = 1")
        _write_file(self.root, "main.ts", 'import * as ut from "./utils"')
        fa = parse_ts_ast(self.root, "main.ts")
        self.assertIsNotNone(fa)
        self.assertIn("ut", fa.imports)
        self.assertEqual(fa.imports["ut"].module, "utils.ts")
        self.assertEqual(fa.imports["ut"].name, "")

    def test_type_only_import(self):
        _write_file(self.root, "types.ts", "export type Foo = string")
        _write_file(self.root, "main.ts", 'import type { Foo } from "./types"')
        fa = parse_ts_ast(self.root, "main.ts")
        self.assertIsNotNone(fa)
        self.assertIn("Foo", fa.imports)

    def test_re_export_named(self):
        _write_file(self.root, "utils.ts", "export const helper = 1")
        _write_file(self.root, "index.ts", 'export { helper } from "./utils"')
        fa = parse_ts_ast(self.root, "index.ts")
        self.assertIsNotNone(fa)
        self.assertIn("helper", fa.imports)

    def test_re_export_star(self):
        _write_file(self.root, "utils.ts", "export const x = 1")
        _write_file(self.root, "index.ts", 'export * from "./utils"')
        fa = parse_ts_ast(self.root, "index.ts")
        self.assertIsNotNone(fa)
        self.assertIn("utils.ts", fa.star_imports)

    def test_export_declaration_promotes_name(self):
        _write_file(self.root, "main.ts", "export function greet() { return 'hi' }")
        fa = parse_ts_ast(self.root, "main.ts")
        self.assertIsNotNone(fa)
        self.assertIn("greet", fa.defines)

    def test_no_string_comment_hits_in_refs(self):
        _write_file(self.root, "api.ts", "export const name = 'hello'\nconst x = 1")
        fa = parse_ts_ast(self.root, "api.ts")
        self.assertIsNotNone(fa)
        # 'name' is a string literal value, not a reference - no ref to it
        for top, attr in fa.references:
            if top == "name":
                self.fail(f"found ref to 'name' in references: ({top}, {attr})")


@unittest.skipIf(not HAS_TS, "tree-sitter not installed")
class TestBuildGraphV2_TS(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.root))

    def test_ts_edge_created(self):
        _write_file(self.root, "util.ts", "export const VALUE = 42")
        _write_file(self.root, "main.ts", 'import { VALUE } from "./util"\nconsole.log(VALUE)')
        tags = [
            {"_type": "tag", "name": "VALUE", "path": "util.ts", "kind": "variable"},
            {"_type": "tag", "name": "main", "path": "main.ts", "kind": "function"},
        ]
        files, edges, defines, sym_refs = build_graph_v2(self.root, tags)
        self.assertIn(("main.ts", "util.ts"), edges)

    def test_mixed_python_ts_repo(self):
        _write_file(self.root, "py_mod.py", "VAL = 1")
        _write_file(self.root, "ts_mod.ts", "export const X = 10")
        _write_file(self.root, "app.py", "from py_mod import VAL\nprint(VAL)")
        tags = [
            {"_type": "tag", "name": "VAL", "path": "py_mod.py", "kind": "variable"},
            {"_type": "tag", "name": "X", "path": "ts_mod.ts", "kind": "variable"},
            {"_type": "tag", "name": "app", "path": "app.py", "kind": "function"},
        ]
        files, edges, defines, sym_refs = build_graph_v2(self.root, tags)
        self.assertIn(("app.py", "py_mod.py"), edges)
        # TS file has no incoming edges from Python (no reference)
        self.assertNotIn(("app.py", "ts_mod.ts"), edges)
    def test_separate_export_statement_promotes_declared_name(self):
        """A declaration followed by `export { name }` should appear in defines."""
        _write_file(self.root, "mod.ts", "function greet() { return 'hi' }\nexport { greet }")
        fa = parse_ts_ast(self.root, "mod.ts")
        self.assertIsNotNone(fa)
        self.assertIn("greet", fa.defines)
        self.assertEqual(fa.defines["greet"], "function")


if __name__ == "__main__":
    unittest.main()
