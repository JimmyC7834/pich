"""Tests for AST-driven graph builder in make_vocab.py."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Allow import from parent directory
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from make_vocab import (
    parse_python_ast, build_python_graph, build_module_index,
    resolve_relative, build_re_exports, strip_comments_and_strings,
    _blank, build_graph_v2, FileAst, ImportRef,
)


def _write_file(root: Path, rel: str, content: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


class TestResolveRelative(unittest.TestCase):
    def test_same_package(self):
        self.assertEqual(resolve_relative("pkg.sub", False, 1, "mod"), "pkg.mod")

    def test_parent_package(self):
        # is_package=True, level=2 -> shifts by 1 -> level=1 -> up 1 from pkg.sub.mod
        self.assertEqual(resolve_relative("pkg.sub.mod", True, 2, "sibling"), "pkg.sub.sibling")

    def test_no_target(self):
        self.assertEqual(resolve_relative("pkg.sub", False, 1, ""), "pkg")

    def test_init_package_offset(self):
        # __init__.py -> is_package=True shifts by 1
        self.assertEqual(resolve_relative("pkg", True, 1, "mod"), "pkg.mod")

    def test_above_root(self):
        self.assertEqual(resolve_relative("mod", False, 3, "x"), "x")


class TestParsePythonAst(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        for child in self.root.iterdir():
            if child.is_file():
                child.unlink()
        self.root.rmdir()

    def _parse(self, rel: str, content: str):
        _write_file(self.root, rel, content)
        return parse_python_ast(self.root, rel)

    def test_function_def(self):
        fa = self._parse("mod.py", "def hello(): pass")
        self.assertIsNotNone(fa)
        self.assertIn("hello", fa.defines)
        self.assertEqual(fa.defines["hello"], "function")

    def test_async_function(self):
        fa = self._parse("mod.py", "async def fetch(): pass")
        self.assertIsNotNone(fa)
        self.assertIn("fetch", fa.defines)
        self.assertEqual(fa.defines["fetch"], "function")

    def test_class_def(self):
        fa = self._parse("mod.py", "class Foo: pass")
        self.assertIsNotNone(fa)
        self.assertIn("Foo", fa.defines)
        self.assertEqual(fa.defines["Foo"], "class")

    def test_constant_assign(self):
        fa = self._parse("mod.py", "MAX_SIZE = 100")
        self.assertIsNotNone(fa)
        self.assertIn("MAX_SIZE", fa.defines)
        self.assertEqual(fa.defines["MAX_SIZE"], "constant")

    def test_annotated_assign(self):
        fa = self._parse("mod.py", "MAX_SIZE: int = 100")
        self.assertIsNotNone(fa)
        self.assertIn("MAX_SIZE", fa.defines)

    def test_private_name_skipped(self):
        fa = self._parse("mod.py", "def _internal(): pass\nclass _Hidden: pass")
        self.assertIsNotNone(fa)
        self.assertNotIn("_internal", fa.defines)
        self.assertNotIn("_Hidden", fa.defines)

    def test_import_binding(self):
        fa = self._parse("mod.py", "import os")
        self.assertIsNotNone(fa)
        self.assertIn("os", fa.imports)
        self.assertEqual(fa.imports["os"].module, "os")

    def test_import_as(self):
        fa = self._parse("mod.py", "import numpy as np")
        self.assertIsNotNone(fa)
        self.assertIn("np", fa.imports)
        self.assertEqual(fa.imports["np"].module, "numpy")

    def test_from_import(self):
        fa = self._parse("mod.py", "from pathlib import Path")
        self.assertIsNotNone(fa)
        self.assertIn("Path", fa.imports)
        self.assertEqual(fa.imports["Path"].module, "pathlib")
        self.assertEqual(fa.imports["Path"].name, "Path")

    def test_from_import_as(self):
        fa = self._parse("mod.py", "from os import path as ospath")
        self.assertIsNotNone(fa)
        self.assertIn("ospath", fa.imports)
        self.assertEqual(fa.imports["ospath"].name, "path")

    def test_star_import(self):
        fa = self._parse("mod.py", "from os import *")
        self.assertIsNotNone(fa)
        self.assertIn("os", fa.star_imports)

    def test_reference_bare_name(self):
        fa = self._parse("mod.py", "import os\nos")
        self.assertIsNotNone(fa)
        self.assertTrue(any(r[0] == "os" and r[1] is None for r in fa.references))

    def test_reference_attribute(self):
        fa = self._parse("mod.py", "import os\nos.path.join('a')")
        self.assertIsNotNone(fa)
        self.assertTrue(any(r[0] == "os" and r[1] == "path" for r in fa.references))

    def test_syntax_error_returns_none(self):
        fa = self._parse("mod.py", "def (:")  # invalid syntax
        self.assertIsNone(fa)


class TestModuleIndex(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "pkg").mkdir(parents=True, exist_ok=True)
        (self.root / "pkg" / "__init__.py").touch()
        _write_file(self.root, "pkg/sub.py", "x = 1")
        _write_file(self.root, "loose.py", "y = 2")

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.root))

    def test_module_index(self):
        idx = build_module_index(self.root, ["pkg/sub.py", "loose.py"])
        self.assertIn("pkg.sub", idx)
        self.assertEqual(idx["pkg.sub"], "pkg/sub.py")
        self.assertIn("loose", idx)
        self.assertEqual(idx["loose"], "loose.py")


class TestReExports(unittest.TestCase):
    def test_re_export_from_init(self):
        root = Path(tempfile.mkdtemp())
        try:
            pkg = root / "pkg"
            pkg.mkdir()
            (pkg / "__init__.py").write_text("from .sub import helper", encoding="utf-8")
            (pkg / "sub.py").write_text("helper = 42", encoding="utf-8")

            asts = {}
            fa = parse_python_ast(root, "pkg/__init__.py")
            if fa:
                asts[fa.path] = fa
            fa_sub = parse_python_ast(root, "pkg/sub.py")
            if fa_sub:
                asts[fa_sub.path] = fa_sub
            mod_idx = {"pkg": "pkg/__init__.py", "pkg.sub": "pkg/sub.py"}

            rex = build_re_exports(asts, mod_idx)
            self.assertIn("pkg", rex)
            self.assertIn("helper", rex["pkg"])
            self.assertEqual(rex["pkg"]["helper"].name, "helper")
        finally:
            import shutil
            shutil.rmtree(str(root))


class TestBuildPythonGraph(unittest.TestCase):
    def test_simple_import_edge(self):
        root = Path(tempfile.mkdtemp())
        try:
            (root / "a.py").write_text("B_VAL = 1\ndef use_b():\n    return B_VAL", encoding="utf-8")
            (root / "b.py").write_text("from a import B_VAL\nresult = B_VAL", encoding="utf-8")

            edges, defines, sym_refs = build_python_graph(root, ["a.py", "b.py"])
            # b.py references B_VAL defined in a.py
            self.assertIn(("b.py", "a.py"), edges)
        finally:
            import shutil
            shutil.rmtree(str(root))

    def test_no_false_edges_from_strings(self):
        root = Path(tempfile.mkdtemp())
        try:
            (root / "a.py").write_text("x = 1", encoding="utf-8")
            (root / "b.py").write_text("s = 'x'  # string, not a reference", encoding="utf-8")
            edges, defines, sym_refs = build_python_graph(root, ["a.py", "b.py"])
            # No edge from b.py -> a.py because 'x' in a string, not a name reference
            self.assertNotIn(("b.py", "a.py"), edges)
        finally:
            import shutil
            shutil.rmtree(str(root))

    def test_multi_define_kept(self):
        """Multi-defined names appear in defines, not dropped by v1 single-definer logic."""
        root = Path(tempfile.mkdtemp())
        try:
            (root / "a.py").write_text("Config = 1", encoding="utf-8")
            (root / "b.py").write_text("Config = 2", encoding="utf-8")
            edges, defines, sym_refs = build_python_graph(root, ["a.py", "b.py"])
            self.assertIn("Config", defines)
            self.assertEqual(len(defines["Config"]), 2)
        finally:
            import shutil
            shutil.rmtree(str(root))


class TestStripCommentsAndStrings(unittest.TestCase):
    def test_python_line_comment(self):
        result = strip_comments_and_strings("x = 1  # comment\n", ".py")
        self.assertIn("x = 1", result)
        self.assertNotIn("comment", result)

    def test_python_triple_quote(self):
        result = strip_comments_and_strings('x = 1\n"""docstring"""\ny = 2\n', ".py")
        self.assertIn("x = 1", result)
        self.assertIn("y = 2", result)
        # the triple-quoted string should be blanked
        lines = result.split("\n")
        self.assertTrue(all(ch == " " for ch in lines[1] if ch != "\n"), "docstring line should be spaces")

    def test_js_line_comment(self):
        result = strip_comments_and_strings("x = 1; // comment\n", ".js")
        self.assertIn("x = 1", result)
        self.assertNotIn("comment", result)

    def test_js_block_comment(self):
        result = strip_comments_and_strings("x = 1; /* block */ y = 2;", ".js")
        self.assertIn("x = 1", result)
        self.assertIn("y = 2", result)
        self.assertNotIn("block", result)

    def test_newlines_preserved(self):
        src = "line1\n# comment\nline3\n"
        result = strip_comments_and_strings(src, ".py")
        self.assertEqual(result.count("\n"), src.count("\n"))
        lines = result.split("\n")
        self.assertEqual(len(lines), 4)
        self.assertEqual(lines[1].strip(), "")

    def test_blank(self):
        self.assertEqual(_blank("hello\nworld"), "     \n     ")
        self.assertEqual(_blank("abc"), "   ")


class TestBuildGraphV2(unittest.TestCase):
    def test_v2_with_tags(self):
        """End-to-end: build_graph_v2 with a simple tags-like structure."""
        root = Path(tempfile.mkdtemp())
        try:
            (root / "a.py").write_text("VAL_A = 1\n", encoding="utf-8")
            (root / "b.py").write_text("from a import VAL_A\nresult = VAL_A\n", encoding="utf-8")
            tags = [
                {"_type": "tag", "name": "VAL_A", "path": "a.py", "kind": "variable"},
                {"_type": "tag", "name": "result", "path": "b.py", "kind": "variable"},
            ]
            files, edges, defines, sym_refs = build_graph_v2(root, tags)
            self.assertIn("a.py", files)
            self.assertIn("b.py", files)
            # b.py -> a.py edge should be present from AST reference
            self.assertIn(("b.py", "a.py"), edges)
        finally:
            import shutil
            shutil.rmtree(str(root))

    def test_v2_preserves_caller_path_strings(self):
        """Regression: ensure path strings in edges match the original form."""
        root = Path(tempfile.mkdtemp())
        try:
            (root / "mod.py").write_text("VALUE = 10\n", encoding="utf-8")
            (root / "caller.py").write_text("from mod import VALUE\nx = VALUE\n", encoding="utf-8")
            tags = [
                {"_type": "tag", "name": "VALUE", "path": "mod.py", "kind": "variable"},
                {"_type": "tag", "name": "x", "path": "caller.py", "kind": "variable"},
            ]
            files, edges, defines, sym_refs = build_graph_v2(root, tags)
            # Check edge keys use same path form as tags
            for src, dst in edges:
                self.assertTrue(any(src == t["path"] for t in tags), f"src {src} not in tags")
                self.assertTrue(any(dst == t["path"] for t in tags), f"dst {dst} not in tags")
        finally:
            import shutil
            shutil.rmtree(str(root))


if __name__ == "__main__":
    unittest.main()
