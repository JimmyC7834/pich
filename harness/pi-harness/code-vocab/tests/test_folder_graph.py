"""Tests for folder-to-folder graph aggregation in make_vocab.py."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from make_vocab import aggregate_folder_graph, render_folder_graph


class TestAggregateFolderGraph(unittest.TestCase):
    """7 test cases for folder graph aggregation and rendering."""

    def test_basic_aggregation(self):
        edges = {
            ("a/x.py", "b/y.py"): 1,
            ("a/x.py", "b/z.py"): 2,
        }
        bucket = {"a/x.py": "a", "b/y.py": "b", "b/z.py": "b"}
        result = aggregate_folder_graph(edges, bucket)
        self.assertEqual(len(result), 1)
        src, dsts = result[0]
        self.assertEqual(src, "a")
        self.assertEqual(len(dsts), 1)
        self.assertEqual(dsts[0][0], "b")
        self.assertEqual(dsts[0][1], 3)

    def test_self_loops_dropped(self):
        edges = {
            ("a/x.py", "a/y.py"): 5,
            ("a/x.py", "b/z.py"): 1,
        }
        bucket = {"a/x.py": "a", "a/y.py": "a", "b/z.py": "b"}
        result = aggregate_folder_graph(edges, bucket)
        # Only the cross-folder edge should remain
        total_dsts = sum(len(dsts) for _, dsts in result)
        self.assertEqual(total_dsts, 1)

    def test_unbucketed_file_edges_dropped(self):
        edges = {
            ("a/x.py", "b/y.py"): 3,
            ("orphan.py", "b/y.py"): 2,
        }
        bucket = {"a/x.py": "a", "b/y.py": "b"}  # orphan.py not in bucket
        result = aggregate_folder_graph(edges, bucket)
        self.assertEqual(len(result), 1)

    def test_sort_by_total_outbound_weight(self):
        edges = {
            ("a/1.py", "b/1.py"): 1,
            ("c/1.py", "b/2.py"): 10,
        }
        bucket = {"a/1.py": "a", "b/1.py": "b", "c/1.py": "c", "b/2.py": "b"}
        result = aggregate_folder_graph(edges, bucket)
        self.assertEqual(result[0][0], "c")  # higher weight first

    def test_empty_graph(self):
        result = aggregate_folder_graph({}, {})
        self.assertEqual(result, [])


class TestRenderFolderGraph(unittest.TestCase):
    def test_basic_render(self):
        edges = [("a", [("b", 3), ("c", 1)])]
        output = render_folder_graph(edges)
        self.assertIn("Folder graph", output)
        self.assertIn("`a/`", output)
        self.assertIn("b", output)
        self.assertIn("c", output)

    def test_max_neighbors_truncation(self):
        edges = [("a", [("b", 1), ("c", 2), ("d", 3), ("e", 4), ("f", 5)])]
        output = render_folder_graph(edges, max_neighbors=3)
        self.assertIn("+2", output)  # 5 destinations, 3 shown, 2 truncated

    def test_max_lines_cap(self):
        # render_folder_graph does NOT sort; uses input order
        edges = [
            ("a", [("b", 10)]),
            ("c", [("d", 5)]),
            ("e", [("f", 1)]),
        ]
        output = render_folder_graph(edges, max_lines=2)
        self.assertIn("a", output)
        self.assertIn("c", output)
        self.assertNotIn("- `e/`", output)
    def test_empty_graph_returns_empty_string(self):
        self.assertEqual(render_folder_graph([]), "")


if __name__ == "__main__":
    unittest.main()
