# Spec — Spreadsheet Engine (model-development benchmark)

Date: 2026-06-21
Status: scoped

## 1. What this is

A **greenfield Python build task** used to benchmark how well different models
develop software through the pi harness. A model is given the spec below and must
build a mini spreadsheet engine from scratch. Performance is judged by:

1. **Did-it-run gate** — the CLI starts and computes the provided examples.
2. **Audit prompt** (§8) — handed to a judge LLM to score correctness, edge-case
   handling, structure, and over-engineering.

The engine is chosen because its core (dependency-graph recalc, cycle detection,
error propagation) is exactly where weaker models cut corners or ship
subtly-wrong results, yet the whole thing fits in ~300–500 lines — small enough
to grade by eye and by audit prompt.

### Non-goals
- No GUI, no real `.xlsx`/Excel compatibility, no network.
- No hidden test suite (grading is did-it-run + audit prompt).
- No string functions, no conditionals, no absolute/relative `$` refs.

## 2. Headline behaviour

```
python sheet.py examples/basic.csv      # prints computed grid as CSV to stdout
```

Input is a CSV file: each field is a cell. File row 1 = spreadsheet row 1,
column 1 = `A`, column 2 = `B`, … Output is the same grid with every formula
replaced by its computed value (or an error code).

## 3. Cell contents

A field is one of:

| Kind | Example | Meaning |
|------|---------|---------|
| Empty | `` | empty cell — `0` in arithmetic, skipped by SUM/AVG/MIN/MAX/COUNT |
| Number | `42`, `3.5`, `-1` | numeric literal |
| Text | `hello` | passes through unchanged; `#VALUE!` if used in arithmetic |
| Formula | `=A1+B2` | starts with `=`, evaluated |

## 4. Formula grammar

```
expr    := term (('+' | '-') term)*
term    := factor (('*' | '/') factor)*
factor  := '-' factor | power
power   := atom ('^' factor)?           # right-associative
atom    := number | ref | func | '(' expr ')'
ref     := [A-Z]+ [0-9]+                 # e.g. A1, AB12
range   := ref ':' ref                   # only as a function argument
func    := NAME '(' (arg (',' arg)*)? ')'
arg     := expr | range
```

- Operators: `+ - * / ^`, unary minus, parentheses. `^` is right-associative;
  `* /` bind tighter than `+ -`.
- Functions (case-insensitive): `SUM`, `AVG` (alias `AVERAGE`), `MIN`, `MAX`,
  `COUNT`. They accept any mix of expressions and ranges; ranges expand to their
  cells.
- `COUNT` returns how many referenced cells are numeric (empty/text not counted).
- `AVG` over zero numeric cells → `#DIV/0!`.

## 5. Evaluation semantics

- **Empty cell** referenced in arithmetic → `0`. Skipped by all aggregate
  functions.
- **Text cell** referenced in arithmetic → `#VALUE!`. Skipped by aggregates.
- **Dependency order**: build a dependency graph and evaluate in topological
  order so every cell sees final inputs (no single-pass left-to-right).
- **Cycles**: every cell participating in a circular reference → `#CYCLE!`.
- **Error propagation**: if a cell's formula references a cell holding an error,
  it inherits that same error code.
- **Out-of-grid ref** (e.g. `=Z99` past the sheet) → `#REF!`.

### Error codes
| Code | Cause |
|------|-------|
| `#ERROR!` | formula fails to parse |
| `#REF!` | reference outside the grid |
| `#DIV/0!` | division by zero, or AVG of no numbers |
| `#VALUE!` | arithmetic on a text cell |
| `#CYCLE!` | circular reference |

## 6. Output format

- Same grid shape as input (same row/column count).
- Numbers: integer if the value is whole (`6`, not `6.0`), else shortest decimal
  (`str(float)`); error codes and text printed verbatim.
- Emit CSV with the stdlib `csv` module.

## 7. Acceptance examples (ship these as `examples/`)

`examples/basic.csv`
```
1,2,=A1+B1
=A1*10,=SUM(A1:B1),=C1^2
```
→
```
1,2,3
10,3,9
```

`examples/errors.csv`
```
=1/0,=A1+5,text,=C1+1
=AVG(),=Z9,=B2,
```
→
```
#DIV/0!,#DIV/0!,text,#VALUE!
#DIV/0!,#REF!,#REF!,
```
(`B1=A1+5` inherits A1's `#DIV/0!`; `D1=C1+1` is arithmetic on text → `#VALUE!`;
`A2=AVG()` no numbers → `#DIV/0!`; `B2=Z9` off-grid → `#REF!`; `C2=B2` inherits
B2's `#REF!`.)

`examples/cycle.csv`
```
=B1,=A1
```
→
```
#CYCLE!,#CYCLE!
```

## 8. Audit prompt (for the judge LLM)

> You are auditing a Python "mini spreadsheet engine". The full spec is in
> `docs/superpowers/specs/2026-06-21-spreadsheet-bench-design.md`. Without being
> charitable, score the submission 0–5 on each axis and give one line of
> evidence per score (file:line where possible):
>
> 1. **Runs** — does `python sheet.py examples/basic.csv` produce the spec's
>    output? Try all three example files.
> 2. **Correctness** — operator precedence, `^` right-associativity, all five
>    functions, empty/text cell rules.
> 3. **Dependency order** — does it topologically order cells, or does it cheat
>    with single-pass / fixed-point iteration that breaks on forward refs?
> 4. **Edge cases** — every error code in §5 produced correctly, including error
>    *propagation* and `#CYCLE!` covering all cells in the cycle.
> 5. **Code quality** — clear module boundaries (tokenize / parse / eval /
>    graph), readable, no dead abstractions.
> 6. **Over-engineering** — flag anything speculative: plugin systems, config for
>    constants, an interface with one impl, a hand-rolled parser combinator
>    framework where a 40-line recursive-descent parser suffices.
>
> End with a total /30 and the single biggest thing you'd send back.

## 9. Repo layout the model should produce

```
sheet.py            # CLI entry: load CSV → evaluate → print CSV
engine/             # (or single file; the model decides — judged in §8.5)
examples/           # basic.csv, errors.csv, cycle.csv
tests/              # smoke tests (pytest) the model writes from §7
README.md           # one-paragraph usage
```

Single-file vs package is the model's call — that choice is itself a signal the
audit scores.
