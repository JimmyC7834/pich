"""Tests for v2 entry-point detection (TS real-world shapes, per-package.json, candidate paths)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from make_vocab import detect_entry_points, _candidate_source_paths, _file_is_entry_point


def _write_file(root: Path, rel: str, content: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


class TestTsRealWorldEntryShapes(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.root))

    def test_ts_shebang_node(self):
        _write_file(self.root, "cli.ts", "#!/usr/bin/env node\nconsole.log('hello')")
        self.assertTrue(_file_is_entry_point(self.root, "cli.ts"))

    def test_require_main(self):
        _write_file(self.root, "cli.ts", 'if (require.main === module) {\n  main()\n}')
        self.assertTrue(_file_is_entry_point(self.root, "cli.ts"))

    def test_import_meta_main(self):
        _write_file(self.root, "cli.ts", 'if (import.meta.main) {\n  main()\n}')
        self.assertTrue(_file_is_entry_point(self.root, "cli.ts"))

    def test_top_level_process_argv(self):
        _write_file(self.root, "cli.ts", "const args = process.argv.slice(2)")
        self.assertTrue(_file_is_entry_point(self.root, "cli.ts"))

    def test_top_level_main_call(self):
        _write_file(self.root, "cli.ts", "main()")
        self.assertTrue(_file_is_entry_point(self.root, "cli.ts"))

    def test_top_level_await_main(self):
        _write_file(self.root, "cli.ts", "await main()")
        self.assertTrue(_file_is_entry_point(self.root, "cli.ts"))

    def test_library_main_ts_not_tagged(self):
        """Library-style main.ts that defines but doesn't call main() is NOT an entry."""
        _write_file(self.root, "main.ts", "export function main() {\n  return 42\n}")
        self.assertFalse(_file_is_entry_point(self.root, "main.ts"))


class TestCandidateSourcePaths(unittest.TestCase):
    def test_extension_swap(self):
        paths = _candidate_source_paths("dist/cli.js")
        self.assertIn("dist/cli.ts", paths)

    def test_build_dir_strip(self):
        paths = _candidate_source_paths("dist/cli.js")
        self.assertIn("cli.ts", paths)
        self.assertIn("src/cli.ts", paths)

    def test_multiple_transforms(self):
        paths = _candidate_source_paths("lib/util.js")
        self.assertIn("lib/util.ts", paths)
        self.assertIn("util.ts", paths)
        self.assertIn("src/util.ts", paths)


class TestPerPackageJson(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.root))

    def test_per_package_package_json_walk(self):
        """Each package.json's main/bin is checked independently."""
        _write_file(self.root, "packages/a/index.js", "module.exports = {}")
        _write_file(self.root, "packages/a/package.json", json.dumps({"main": "index.js"}))
        _write_file(self.root, "packages/b/cli.js", 'console.log("hello")')
        _write_file(self.root, "packages/b/package.json", json.dumps({"bin": "cli.js"}))
        detected = detect_entry_points(self.root, ["packages/a/index.js", "packages/b/cli.js"])
        self.assertIn("packages/a/index.js", detected)
        self.assertIn("packages/b/cli.js", detected)


if __name__ == "__main__":
    unittest.main()
