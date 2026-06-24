// Seed the ralph board with the Spreadsheet Engine benchmark build tasks.
// The model under test works these one at a time. Idempotent-ish.
//   node scripts/seed-spreadsheet-bench.cjs
const Database = require("../agent/extensions/pi-ralph/node_modules/better-sqlite3");
const db = new Database(".pi/ralph/ralph.db");
const now = () => new Date().toISOString();
const PROJECT = "spreadsheet-bench";
const PLAN = "docs/superpowers/plans/2026-06-21-spreadsheet-bench.md";
const SPEC = "docs/superpowers/specs/2026-06-21-spreadsheet-bench-design.md";

db.prepare(
  `INSERT INTO projects(id,name,created_at,active_run) VALUES(?,?,?,0)
   ON CONFLICT(id) DO NOTHING`,
).run(PROJECT, "Spreadsheet Engine (model benchmark)", now());

const existing = db.prepare(`SELECT COUNT(*) n FROM tasks WHERE project_id=?`).get(PROJECT).n;
if (existing > 0) { console.log(`Project ${PROJECT} already has ${existing} tasks — aborting to avoid duplicates.`); process.exit(0); }

const ctx = `Spec: ${SPEC}. Plan: ${PLAN}.`;
const tasks = [
  { id: "ss-1", dep: [], title: "Scaffold + CSV passthrough",
    verify: "python sheet.py examples/literals.csv",
    spec: `${ctx} Create sheet.py CLI: read CSV path from argv, parse into a grid of cells, emit the same grid as CSV via stdlib csv (no evaluation yet; formulas left as-is). Add examples/literals.csv (literals + text only) that round-trips unchanged. Plan Task 1.` },
  { id: "ss-2", dep: ["ss-1"], title: "Tokenizer + recursive-descent parser",
    verify: "python -m pytest tests/test_parser.py -q",
    spec: `${ctx} Tokenize and parse formula strings into an AST per spec §4: numbers, refs, ranges (func args only), + - * / ^, unary minus, parens, function calls. Correct precedence; ^ right-associative. Parse failure -> a marker that later becomes #ERROR!. Write tests/test_parser.py covering precedence and ^ associativity. Plan Task 2.` },
  { id: "ss-3", dep: ["ss-2"], title: "Reference & range resolution",
    verify: "python -m pytest tests/test_refs.py -q",
    spec: `${ctx} Map A1-style refs to grid coords incl. multi-letter columns (AA, AB). Off-grid ref -> #REF!. Expand A1:B3 ranges to ordered cell lists. Write tests/test_refs.py. Plan Task 3.` },
  { id: "ss-4", dep: ["ss-3"], title: "Evaluator: arithmetic + functions",
    verify: "python -m pytest tests/test_eval.py -q",
    spec: `${ctx} Evaluate AST against resolved values: arithmetic, SUM/AVG(AVERAGE)/MIN/MAX/COUNT. Empty cell -> 0 in arithmetic, skipped by aggregates; text -> #VALUE! in arithmetic, skipped by aggregates; COUNT counts numeric only. 1/0 and AVG-of-none -> #DIV/0!. Write tests/test_eval.py. Plan Task 4.` },
  { id: "ss-5", dep: ["ss-4"], title: "Dependency graph + topological recalc",
    verify: "python sheet.py examples/basic.csv",
    spec: `${ctx} Build the cell dependency graph and evaluate in topological order so forward references resolve (no single left-to-right pass). Add examples/basic.csv + examples/basic.out from spec §7; verify CLI output matches. Plan Task 5.` },
  { id: "ss-6", dep: ["ss-5"], title: "Cycle detection -> #CYCLE!",
    verify: "python sheet.py examples/cycle.csv",
    spec: `${ctx} Detect circular references; every cell in a cycle -> #CYCLE!. Add examples/cycle.csv + examples/cycle.out from spec §7; verify output matches. Plan Task 6.` },
  { id: "ss-7", dep: ["ss-5"], title: "Error propagation",
    verify: "python sheet.py examples/errors.csv",
    spec: `${ctx} A formula referencing an error cell inherits that error code. Add examples/errors.csv + examples/errors.out from spec §7 (covers #DIV/0!, #REF!, #VALUE! propagation); verify output matches. Plan Task 7.` },
  { id: "ss-8", dep: ["ss-6", "ss-7"], title: "README + final smoke",
    verify: "python -m pytest -q",
    spec: `${ctx} Write a one-paragraph README.md (usage). Confirm all three spec examples pass and the full pytest suite is green. Plan Task 8.` },
];

const ins = db.prepare(
  `INSERT INTO tasks(id,project_id,title,spec,priority,status,depends_on,verify,created_by,created_at)
   VALUES(@id,@project_id,@title,@spec,@priority,'todo',@depends_on,@verify,'human',@created_at)`,
);
let p = tasks.length;
for (const t of tasks) {
  ins.run({
    id: t.id, project_id: PROJECT, title: t.title, spec: t.spec,
    priority: p--, depends_on: JSON.stringify(t.dep), verify: t.verify,
    created_at: now(),
  });
}
console.log(`Seeded ${tasks.length} tasks into project ${PROJECT}.`);
