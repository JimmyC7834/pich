"""Tests for glob-walk entry detection and vocab_find entry-point listing."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from make_vocab import detect_entry_points
from vocab_find import list_entry_points, render_entry_points, _load_graph_cache


def _write_file(root: Path, rel: str, content: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def _make_cache(tags_path: Path, entry_points: list[str]):
    """Write a mock cache file with entry_points."""
    data = {
        "key": "test",
        "files": entry_points,
        "edges": [],
        "defines": {},
        "sym_refs": {},
        "pr": {},
        "entry_points": entry_points,
    }
    cache_path = tags_path.with_suffix(tags_path.suffix + ".cache")
    cache_path.write_text(json.dumps(data), encoding="utf-8")


class TestEntryPointsGlobWalk(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.root))

    def test_glob_walk_catches_thin_entry(self):
        """A thin CLI file with shebang but no ctags symbols is caught by os.walk."""
        _write_file(self.root, "cli.ts", "#!/usr/bin/env node\nconsole.log('hello')")
        # files=list is empty (no ctags symbols), but glob walk catches it
        detected = detect_entry_points(self.root, [])
        self.assertIn("./cli.ts", detected)

    def test_walk_excludes_node_modules(self):
        _write_file(self.root, "node_modules/thing/cli.js", "#!/usr/bin/env node\nx()")
        _write_file(self.root, "src/cli.js", "#!/usr/bin/env node\nx()")
        detected = detect_entry_points(self.root, [])
        # node_modules should be excluded
        self.assertNotIn("node_modules/thing/cli.js", detected)
        # src/cli.js should be found
        self.assertIn("./src/cli.js", detected)

    def test_walk_excludes_dist(self):
        _write_file(self.root, "dist/cli.js", "#!/usr/bin/env node\nx()")
        _write_file(self.root, "src/cli.py", "if __name__ == '__main__':\n    main()")
        detected = detect_entry_points(self.root, [])
        self.assertNotIn("dist/cli.js", detected)


class TestVocabFindEntries(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.tags = self.tmp / "tags.json"
        self.tags.write_text("", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.tmp))

    def test_list_entry_points_no_scope(self):
        _make_cache(self.tags, ["a.py", "b.py"])
        eps = list_entry_points(self.tags, scope=None)
        self.assertEqual(eps, ["a.py", "b.py"])

    def test_list_entry_points_with_scope(self):
        _make_cache(self.tags, ["src/cli.py", "tests/test_main.py", "utils/helper.py"])
        eps = list_entry_points(self.tags, scope="src")
        self.assertEqual(eps, ["src/cli.py"])

    def test_render_entry_points(self):
        output = render_entry_points(["a.py", "b.py"], scope=None)
        self.assertIn("Entry points", output)
        self.assertIn("a.py", output)
        self.assertIn("b.py", output)


if __name__ == "__main__":
    unittest.main()
