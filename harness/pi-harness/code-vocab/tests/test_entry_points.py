"""Tests for entry-point detection in make_vocab.py."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from make_vocab import detect_entry_points, _file_is_entry_point


def _write_file(root: Path, rel: str, content: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


class TestDetectEntryPoints(unittest.TestCase):
    """14 test cases covering Python and TS entry patterns."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(str(self.root))

    def _detect(self, files: list[str]) -> set[str]:
        return detect_entry_points(self.root, files)

    # Python patterns
    def test_python_main_block_single_quotes(self):
        _write_file(self.root, "cli.py", "if __name__ == '__main__':\n    main()")
        self.assertIn("cli.py", self._detect(["cli.py"]))

    def test_python_main_block_double_quotes(self):
        _write_file(self.root, "cli.py", 'if __name__ == "__main__":\n    main()')
        self.assertIn("cli.py", self._detect(["cli.py"]))

    def test_python_def_main(self):
        _write_file(self.root, "cli.py", "def main():\n    pass")
        self.assertIn("cli.py", self._detect(["cli.py"]))

    def test_python_async_def_main(self):
        _write_file(self.root, "cli.py", "async def main():\n    pass")
        self.assertIn("cli.py", self._detect(["cli.py"]))

    def test_python_fastapi_app(self):
        _write_file(self.root, "app.py", "app = FastAPI()")
        self.assertIn("app.py", self._detect(["app.py"]))

    def test_python_flask_app(self):
        _write_file(self.root, "app.py", "app = Flask(__name__)")
        self.assertIn("app.py", self._detect(["app.py"]))

    # TS patterns
    def test_ts_export_default_function(self):
        _write_file(self.root, "cli.ts", "export default function main() {}")
        self.assertIn("cli.ts", self._detect(["cli.ts"]))

    def test_ts_export_default_async_function(self):
        _write_file(self.root, "cli.ts", "export default async function main() {}")
        self.assertIn("cli.ts", self._detect(["cli.ts"]))

    # package.json patterns
    def test_package_json_main_field(self):
        _write_file(self.root, "index.js", "module.exports = {}")
        pkg = {"main": "index.js"}
        _write_file(self.root, "package.json", json.dumps(pkg))
        self.assertIn("index.js", self._detect(["index.js"]))

    def test_package_json_bin_string(self):
        _write_file(self.root, "cli.js", 'console.log("hello")')
        pkg = {"bin": "cli.js"}
        _write_file(self.root, "package.json", json.dumps(pkg))
        self.assertIn("cli.js", self._detect(["cli.js"]))

    def test_package_json_bin_map(self):
        _write_file(self.root, "bin/cli.js", 'console.log("hello")')
        pkg = {"bin": {"myapp": "bin/cli.js"}}
        _write_file(self.root, "package.json", json.dumps(pkg))
        self.assertIn("bin/cli.js", self._detect(["bin/cli.js"]))

    # Tag-prefixed paths
    def test_tag_prefixed_paths(self):
        _write_file(self.root, "src/cli.py", "if __name__ == '__main__':\n    main()")
        self.assertIn("src/cli.py", self._detect(["src/cli.py"]))

    def test_class_method_main_does_not_qualify(self):
        _write_file(self.root, "mod.py", "class Foo:\n    def main(self):\n        pass")
        detected = self._detect(["mod.py"])
        self.assertNotIn("mod.py", detected)

    def test_empty_file_no_match(self):
        _write_file(self.root, "empty.py", "")
        self.assertNotIn("empty.py", self._detect(["empty.py"]))


if __name__ == "__main__":
    unittest.main()
