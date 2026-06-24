// Clone the spreadsheet-bench tasks into 4 per-model eval boards.
//   node scripts/seed-spreadsheet-eval.cjs
const Database = require("../agent/extensions/pi-ralph/node_modules/better-sqlite3");
const db = new Database(".pi/ralph/ralph.db");
const now = () => new Date().toISOString();
const BASE = "spreadsheet-bench";
const VARIANTS = ["eval-flash-high", "eval-flash-xhigh", "eval-pro-high", "eval-pro-xhigh"];

const base = db.prepare(`SELECT * FROM tasks WHERE project_id=? ORDER BY priority DESC`).all(BASE);
if (base.length === 0) { console.error(`No base tasks in ${BASE}; run seed-spreadsheet-bench.cjs first.`); process.exit(1); }

const insProj = db.prepare(
  `INSERT INTO projects(id,name,created_at,active_run) VALUES(?,?,?,0) ON CONFLICT(id) DO NOTHING`);
const insTask = db.prepare(
  `INSERT INTO tasks(id,project_id,title,spec,priority,status,depends_on,verify,created_by,created_at)
   VALUES(@id,@project_id,@title,@spec,@priority,'todo',@depends_on,@verify,'human',@created_at)`);

for (const proj of VARIANTS) {
  const existing = db.prepare(`SELECT COUNT(*) n FROM tasks WHERE project_id=?`).get(proj).n;
  if (existing > 0) { console.log(`${proj} already has ${existing} tasks — skipping.`); continue; }
  insProj.run(proj, `Spreadsheet Engine eval — ${proj.replace("eval-", "")}`, now());
  for (const t of base) {
    const dep = JSON.parse(t.depends_on).map((d) => `${proj}-${d}`);
    insTask.run({
      id: `${proj}-${t.id}`, project_id: proj, title: t.title, spec: t.spec,
      priority: t.priority, depends_on: JSON.stringify(dep), verify: t.verify,
      created_at: now(),
    });
  }
  console.log(`Seeded ${base.length} tasks into ${proj}.`);
}
