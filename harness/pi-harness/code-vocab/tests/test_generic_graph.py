"""Tests for the generic tree-sitter AST tier (langspec-driven).

Skipped when tree-sitter-language-pack / the Go grammar isn't installed.
"""
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import make_vocab as mv  # noqa: E402


def _go_unavailable() -> bool:
    return mv._get_parser("go") is None


def _write(root: Path, rel: str, body: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(body), encoding="utf-8")


class TestLangSpecRegistry(unittest.TestCase):
    def test_go_spec_registered(self):
        from langspec import LANG_SPECS
        self.assertIn(".go", LANG_SPECS)
        spec = LANG_SPECS[".go"]
        self.assertEqual(spec.grammar, "go")
        self.assertIn(".go", spec.exts)

    def test_go_is_exported_uses_capitalization(self):
        from langspec import LANG_SPECS
        spec = LANG_SPECS[".go"]
        self.assertTrue(spec.is_exported("AddNumbers"))
        self.assertFalse(spec.is_exported("helper"))


class TestParseGenericAst(unittest.TestCase):
    def setUp(self):
        if _go_unavailable():
            self.skipTest("go grammar not installed")
        self.root = Path(tempfile.mkdtemp())
        from langspec import LANG_SPECS
        self.spec = LANG_SPECS[".go"]

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.root), ignore_errors=True)

    def test_exported_define_present_unexported_absent(self):
        _write(self.root, "mathx/mathx.go", """
            package mathx
            func AddNumbers(a int, b int) int { return a + b }
            func helper() int { return 1 }
        """)
        fa = mv.parse_generic_ast(self.root, "mathx/mathx.go", self.spec)
        self.assertIsNotNone(fa)
        self.assertIn("AddNumbers", fa.defines)
        self.assertNotIn("helper", fa.defines)

    def test_import_resolves_to_repo_file(self):
        _write(self.root, "mathx/mathx.go", """
            package mathx
            func AddNumbers(a int, b int) int { return a + b }
        """)
        _write(self.root, "cmd/main.go", """
            package main
            import "example.com/proj/mathx"
            func main() { _ = mathx.AddNumbers(1, 2) }
        """)
        fa = mv.parse_generic_ast(self.root, "cmd/main.go", self.spec)
        self.assertIsNotNone(fa)
        self.assertIn("mathx", fa.imports)
        self.assertEqual(fa.imports["mathx"].module, "mathx/mathx.go")
        self.assertEqual(fa.imports["mathx"].name, "")


class TestBuildGenericGraph(unittest.TestCase):
    def setUp(self):
        if _go_unavailable():
            self.skipTest("go grammar not installed")
        self.root = Path(tempfile.mkdtemp())
        from langspec import LANG_SPECS
        self.spec = LANG_SPECS[".go"]

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.root), ignore_errors=True)

    def test_go_define_and_edge(self):
        _write(self.root, "mathx/mathx.go", """
            package mathx
            func AddNumbers(a int, b int) int { return a + b }
        """)
        _write(self.root, "cmd/main.go", """
            package main
            import "example.com/proj/mathx"
            func main() { _ = mathx.AddNumbers(1, 2) }
        """)
        files = ["mathx/mathx.go", "cmd/main.go"]
        edges, defines, sym_refs = mv.build_generic_graph(self.root, files, self.spec)
        self.assertIn("mathx/mathx.go", defines.get("AddNumbers", set()))
        self.assertIn(("cmd/main.go", "mathx/mathx.go"), edges)

    def test_unexported_name_makes_no_define(self):
        _write(self.root, "a/a.go", """
            package a
            func helper() int { return 1 }
        """)
        _, defines, _ = mv.build_generic_graph(self.root, ["a/a.go"], self.spec)
        self.assertNotIn("helper", defines)


class TestBuildGraphV2Dispatch(unittest.TestCase):
    def setUp(self):
        if _go_unavailable():
            self.skipTest("go grammar not installed")
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.root), ignore_errors=True)

    def test_dispatch_suppresses_lexical_false_edge(self):
        # main.go USES AddNumbers but does NOT import mathx. The lexical tier
        # makes a (false) token-match edge; the AST tier (no global-definer
        # fallback) does not. So dispatch to the AST tier removes the edge.
        _write(self.root, "mathx/mathx.go", """
            package mathx
            func AddNumbers(a int, b int) int { return a + b }
        """)
        _write(self.root, "cmd/main.go", """
            package main
            func main() { _ = AddNumbers(1, 2) }
        """)
        tags = [
            {"_type": "tag", "name": "AddNumbers", "path": "mathx/mathx.go", "kind": "function"},
            {"_type": "tag", "name": "main", "path": "cmd/main.go", "kind": "function"},
        ]
        _, edges, _, _ = mv.build_graph_v2(self.root, tags)
        self.assertNotIn(("cmd/main.go", "mathx/mathx.go"), edges)

    def test_proper_import_creates_ast_edge(self):
        _write(self.root, "mathx/mathx.go", """
            package mathx
            func AddNumbers(a int, b int) int { return a + b }
        """)
        _write(self.root, "cmd/main.go", """
            package main
            import "example.com/proj/mathx"
            func main() { _ = mathx.AddNumbers(1, 2) }
        """)
        tags = [
            {"_type": "tag", "name": "AddNumbers", "path": "mathx/mathx.go", "kind": "function"},
            {"_type": "tag", "name": "main", "path": "cmd/main.go", "kind": "function"},
        ]
        _, edges, _, _ = mv.build_graph_v2(self.root, tags)
        self.assertIn(("cmd/main.go", "mathx/mathx.go"), edges)

    def test_uninstalled_grammar_falls_through_to_lexical(self):
        # With the grammar unavailable, the bare-name use SHOULD still produce
        # a lexical token-match edge (proving fallthrough to _build_nonpython_graph).
        _write(self.root, "mathx/mathx.go", """
            package mathx
            func AddNumbers(a int, b int) int { return a + b }
        """)
        _write(self.root, "cmd/main.go", """
            package main
            func main() { _ = AddNumbers(1, 2) }
        """)
        tags = [
            {"_type": "tag", "name": "AddNumbers", "path": "mathx/mathx.go", "kind": "function"},
            {"_type": "tag", "name": "main", "path": "cmd/main.go", "kind": "function"},
        ]
        orig = mv._get_parser
        mv._get_parser = lambda g: None
        try:
            _, edges, _, _ = mv.build_graph_v2(self.root, tags)
        finally:
            mv._get_parser = orig
        self.assertIn(("cmd/main.go", "mathx/mathx.go"), edges)


class TestGenericEntryPoints(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.root), ignore_errors=True)

    def test_go_main_is_entry_point(self):
        _write(self.root, "cmd/main.go", """
            package main
            func main() { println("hi") }
        """)
        self.assertTrue(mv._file_is_entry_point(self.root, "cmd/main.go"))

    def test_go_library_is_not_entry_point(self):
        _write(self.root, "lib/lib.go", """
            package lib
            func Helper() int { return 1 }
        """)
        self.assertFalse(mv._file_is_entry_point(self.root, "lib/lib.go"))

    def test_go_extension_in_entry_walk_exts(self):
        self.assertIn(".go", mv._ENTRY_WALK_EXTS)


class TestGetParser(unittest.TestCase):
    def test_returns_parser_for_known_grammar(self):
        if _go_unavailable():
            self.skipTest("go grammar not installed")
        self.assertIsNotNone(mv._get_parser("go"))

    def test_returns_none_for_unknown_grammar(self):
        self.assertIsNone(mv._get_parser("not_a_real_grammar_xyz"))


if __name__ == "__main__":
    unittest.main()
