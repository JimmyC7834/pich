# Audit — Spreadsheet Engine benchmark (4 models)

Date: 2026-06-21
Spec: `2026-06-21-spreadsheet-bench-design.md`
Workspaces: `C:\Users\c7834\Documents\git-repos\pi-test\{flash-high,flash-xhigh,pro-high,pro-xhigh}`
Models (from session `model_change` records): all **deepseek-v4**, flash vs pro, thinking high vs xhigh.

## Scoreboard

Did-it-run = each engine vs the spec's three canonical examples (§7), not the model's own.

| Run | Model / think | basic | errors | cycle | self-tests | engine LOC | build time | tool-errs |
|-----|---------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **pro-high**    | pro @ high   | ✅ | ✅ | ✅ | 87 ✅ | 459 | 10.1m | 9 |
| **flash-xhigh** | flash @ xhigh| ✅ | ✅ | ✅ | 61 ✅ | 452 | 7.9m | 12 |
| pro-xhigh       | pro @ xhigh  | ❌ | ✅ | ✅ | 70 ✅ | 429 | 7.2m | 8 |
| flash-high      | flash @ high | ✅ | ❌ | ✅ | 65 ✅ | 308 | 8.0m | 10 |

**Two perfect (pro-high, flash-xhigh); two shipped one spec bug each — despite all four self-test suites passing green.** That gap (green self-tests, red against spec) is the benchmark working as intended: the models wrote tests that didn't exercise the edge they got wrong.

## Per-model findings

### pro-high — best overall ✅ 3/3
Correct off-grid `#REF!` (`sheet.py:88-93` returns REF_ERROR for keys absent from the results map), whole-float→int formatting (`sheet.py:114-116`, even has a `ponytail:` comment), Kahn topo-sort with a proper dependents map, cycle survivors → `#CYCLE!`. Heaviest submission: `EvalError`/`Coord`/`Error`-node classes and 494 LOC of tests — defensible but the most ceremony for the scope. Slowest (10m) and parses each formula twice (build + eval).

### flash-xhigh — best value ✅ 3/3
The flash model gets everything right *at xhigh*. Single-file engine (`engine/__init__.py`), class AST. Correct `#REF!` via `resolve_ref` bounds-check, `_fmt_value` strips `.0`. Smells: every AST node carries `__slots__`+`__repr__`; a `_TOKEN_VALUE` dispatch dict where a few `if`s would do; **range expansion hardcodes `10**6, 10**6`** (`_eval_func`) instead of grid dims — works only because `get_cell` re-checks bounds. Mild over-engineering, no correctness cost.

### pro-xhigh — formatting bug ❌ (basic)
Outputs `10.0,3.0,9.0` not `10,3,9`. Root cause: `sheet.py:149-151` emits `str(v)` with **no whole-float→int branch** — the one place pro-high added it, pro-xhigh omitted. Everything else correct (`#REF!`, errors, cycle all pass). Also: `topo_sort` is O(V·E) — rescans `for other in deps` per node (fine at this size, won't scale). One-line fix.

### flash-high — `#REF!` bug ❌ (errors)
`=Z9` (off-grid) returns `0` instead of `#REF!`, and anything referencing it inherits the wrong value. Root cause: `refs.py:3-4` sets grid bounds to **Excel's maximum** (`10**6 × 16384`) and `evaluate()` defaults to those, so a ref past the *actual* sheet is treated as an empty in-grid cell (`→ None → 0`) rather than out-of-grid. Conflated "sheet bounds" with "Excel bounds." Otherwise the leanest, cleanest code (308 LOC, tuple AST). Fix: pass real grid dims into `evaluate`/`_cell_value`.

## Cross-cutting notes
- **More thinking isn't uniformly better** (n=1): xhigh *rescued* flash (high failed → xhigh passed) but pro-high (high) beat pro-xhigh (xhigh), which regressed on trivial formatting. Don't over-read one trial.
- All four: correct Kahn topological recalc and correct `#CYCLE!` over all cycle members — nobody cheated with single-pass or fixed-point iteration. The dependency-graph core, the hardest part, was universally solid.
- All four parse formulas twice (dep-graph build + eval). Minor; none cached.
- Tool-errors (8-12 each) were recoverable bash/edit retries, not fatal.

## Bug-fix cheat-sheet
- `flash-high/refs.py:3-4` + `eval.py` — thread actual `nrows/ncols` instead of Excel maxima.
- `pro-xhigh/sheet.py:149-151` — add `if isinstance(v,float) and v==int(v): v=int(v)` before `str(v)`.
