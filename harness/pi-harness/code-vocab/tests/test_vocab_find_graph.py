"""Tests for graph query functions in vocab_find.py."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vocab_find import (
    query_imports, query_imported_by, query_neighbors,
    render_graph_query, _load_graph_cache, _normalize_path,
    _is_under, _aggregate_to_folder,
)


def _make_cache(tags_path: Path, edges: list, entry_points: list[str] | None = None):
    """Write a mock cache file."""
    data = {
        "key": "test",
        "files": sorted({e[0] for e in edges} | {e[1] for e in edges}),
        "edges": edges,
        "defines": {},
        "sym_refs": {},
        "pr": {},
    }
    if entry_points is not None:
        data["entry_points"] = entry_points
    cache_path = tags_path.with_suffix(tags_path.suffix + ".cache")
    cache_path.write_text(json.dumps(data), encoding="utf-8")


class TestCacheHelpers(unittest.TestCase):
    def test_normalize_path(self):
        self.assertEqual(_normalize_path("./a/b.py"), "a/b.py")
        self.assertEqual(_normalize_path("a\\b.py"), "a/b.py")
        self.assertEqual(_normalize_path("a/b.py"), "a/b.py")

    def test_is_under(self):
        self.assertTrue(_is_under("a/b/c.py", "a"))
        self.assertTrue(_is_under("a/b/c.py", "a/b"))
        self.assertTrue(_is_under("a", "a"))
        self.assertFalse(_is_under("b/c.py", "a"))

    def test_aggregate_to_folder(self):
        self.assertEqual(_aggregate_to_folder("a/b/c.py", 1), "a")
        self.assertEqual(_aggregate_to_folder("a/b/c.py", 2), "a/b")
        # shallow path
        self.assertEqual(_aggregate_to_folder("root.py", 2), "root.py")
        self.assertEqual(_aggregate_to_folder("a", 1), "a")


class TestQueryImportsFile(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.tags = self.tmp / "tags.json"
        self.root = self.tmp
        _make_cache(self.tags, [
            ["a.py", "b.py", 1],
            ["a.py", "c.py", 2],
            ["b.py", "c.py", 1],
        ])
        # Create the dirs so is_dir() checks work
        (self.tmp / "src").mkdir(exist_ok=True)

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.tmp))

    def test_file_imports(self):
        result = query_imports(self.tags, "a.py", self.root)
        self.assertEqual(len(result), 2)
        paths = {p for p, _ in result}
        self.assertIn("b.py", paths)
        self.assertIn("c.py", paths)

    def test_file_imports_no_matches(self):
        result = query_imports(self.tags, "nonexistent.py", self.root)
        self.assertEqual(result, [])


class TestQueryImportedByFile(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.tags = self.tmp / "tags.json"
        self.root = self.tmp
        _make_cache(self.tags, [
            ["a.py", "c.py", 1],
            ["b.py", "c.py", 2],
        ])

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.tmp))

    def test_file_imported_by(self):
        result = query_imported_by(self.tags, "c.py", self.root)
        self.assertEqual(len(result), 2)
        paths = {p for p, _ in result}
        self.assertIn("a.py", paths)
        self.assertIn("b.py", paths)

    def test_weight_sum(self):
        result = query_imported_by(self.tags, "c.py", self.root)
        total = sum(w for _, w in result)
        self.assertEqual(total, 3)


class TestQueryFolderAggregation(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.tags = self.tmp / "tags.json"
        self.root = self.tmp
        (self.tmp / "src").mkdir(exist_ok=True)
        (self.tmp / "other").mkdir(exist_ok=True)
        (self.tmp / "lib").mkdir(exist_ok=True)
        _make_cache(self.tags, [
            ["src/a.py", "lib/x.py", 1],
            ["src/b.py", "lib/y.py", 2],
            ["src/a.py", "lib/y.py", 3],
            ["other/z.py", "lib/x.py", 1],
        ])

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.tmp))

    def test_folder_imports(self):
        result = query_imports(self.tags, "src", self.root)
        self.assertGreater(len(result), 0)
        # Destinations should be aggregated to folder depth 1
        for dst, _ in result:
            self.assertTrue(dst.startswith("lib") or dst.startswith("other"))

    def test_folder_imported_by(self):
        result = query_imported_by(self.tags, "lib", self.root)
        self.assertGreater(len(result), 0)
        for src, _ in result:
            self.assertTrue(src.startswith("src") or src.startswith("other"))


class TestQueryNeighbors(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.tags = self.tmp / "tags.json"
        self.root = self.tmp
        _make_cache(self.tags, [
            ["a.py", "b.py", 1],
            ["b.py", "c.py", 2],
        ])

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.tmp))

    def test_neighbors(self):
        result = query_neighbors(self.tags, "b.py", self.root)
        self.assertIn("imports", result)
        self.assertIn("imported_by", result)
        self.assertEqual(len(result["imports"]), 1)
        self.assertEqual(len(result["imported_by"]), 1)


class TestRenderQuery(unittest.TestCase):
    def test_render_with_hits(self):
        output = render_graph_query("imports", "a.py", [("b.py", 2), ("c.py", 1)])
        self.assertIn("Imports from", output)
        self.assertIn("b.py", output)
        self.assertIn("c.py", output)
        self.assertIn("2 edges", output)

    def test_render_no_hits(self):
        output = render_graph_query("imports", "a.py", [])
        self.assertIn("no edges", output)

    def test_render_single_edge(self):
        output = render_graph_query("imported_by", "x.py", [("y.py", 1)])
        self.assertIn("1 edge", output)


if __name__ == "__main__":
    unittest.main()
