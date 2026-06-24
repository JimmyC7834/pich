# Plan — Spreadsheet Engine benchmark build

Spec: `docs/superpowers/specs/2026-06-21-spreadsheet-bench-design.md`
Date: 2026-06-21

This plan is what the **model under test** executes (driven by the ralph tasks in
`scripts/seed-spreadsheet-bench.cjs`). It is intentionally feature-level, not
line-level: enough to anchor acceptance criteria, but leaving design choices
(single file vs package, parser style) to the model so the build discriminates.

Each task ships its own pytest smoke test derived from the spec examples; ralph's
`verify` runs them as a soft gate.

## Task 1 — Scaffold + CSV passthrough
Create `sheet.py` CLI: read a CSV path argv, parse into a grid of cells, emit the
same grid as CSV (no evaluation yet — literals/text pass through, formulas left
as-is). `examples/literals.csv` round-trips unchanged.
**Verify:** `python sheet.py examples/literals.csv` exits 0 and echoes input.

## Task 2 — Tokenizer + recursive-descent parser
Tokenize and parse formula strings into an AST per §4 grammar: numbers, refs,
ranges (only as func args), `+ - * / ^`, unary minus, parens, function calls.
Precedence and `^` right-associativity correct. Parse failure → marker that
becomes `#ERROR!`.
**Verify:** `pytest tests/test_parser.py` — precedence + associativity cases.

## Task 3 — Reference & range resolution
Map `A1`-style refs to grid coordinates (multi-letter columns: `AA`, `AB`).
Off-grid ref → `#REF!`. Expand `A1:B3` ranges to ordered cell lists.
**Verify:** `pytest tests/test_refs.py`.

## Task 4 — Evaluator (arithmetic + functions)
Evaluate an AST against resolved cell values: arithmetic, the five functions
(SUM/AVG/MIN/MAX/COUNT), empty→0 in arithmetic / skipped in aggregates, text→
`#VALUE!` in arithmetic / skipped in aggregates. `1/0` and AVG-of-none →
`#DIV/0!`.
**Verify:** `pytest tests/test_eval.py`.

## Task 5 — Dependency graph + topological recalc
Build the cell dependency graph and evaluate in topological order so forward
references resolve correctly (no left-to-right single pass). `examples/basic.csv`
matches spec output.
**Verify:** `python sheet.py examples/basic.csv` matches `examples/basic.out`.

## Task 6 — Cycle detection
Detect circular references; every cell in a cycle → `#CYCLE!`.
`examples/cycle.csv` matches spec output.
**Verify:** `python sheet.py examples/cycle.csv` matches `examples/cycle.out`.

## Task 7 — Error propagation
A formula referencing an error cell inherits that error code. `examples/errors.csv`
matches spec output (covers `#DIV/0!`, `#REF!`, `#VALUE!` propagation).
**Verify:** `python sheet.py examples/errors.csv` matches `examples/errors.out`.

## Task 8 — README + final smoke
One-paragraph `README.md` (usage), confirm all three spec examples pass and the
full pytest suite is green.
**Verify:** `pytest -q && python sheet.py examples/basic.csv`.

## Dependency order
```
1 ──> 2 ──> 3 ──> 4 ──> 5 ──> 6
                         └──> 7
6,7 ──────────────────────────> 8
```
