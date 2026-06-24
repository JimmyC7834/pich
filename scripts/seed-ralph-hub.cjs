// Seed the ralph board with the Pi Agent Hub (Phase 1) implementation tasks.
// Idempotent-ish: refuses to double-insert if hub tasks already exist.
const Database = require("../agent/extensions/pi-ralph/node_modules/better-sqlite3");
const db = new Database(".pi/ralph/ralph.db");
const now = () => new Date().toISOString();
const PROJECT = "pi-hub-panel";
const PLAN = "docs/superpowers/plans/2026-06-20-pi-hub-panel.md";

db.prepare(
  `INSERT INTO projects(id,name,created_at,active_run) VALUES(?,?,?,0)
   ON CONFLICT(id) DO NOTHING`,
).run(PROJECT, "Pi Agent Hub (Phase 1)", now());

const existing = db.prepare(`SELECT COUNT(*) n FROM tasks WHERE project_id=?`).get(PROJECT).n;
if (existing > 0) { console.log(`Project ${PROJECT} already has ${existing} tasks — aborting to avoid duplicates.`); process.exit(0); }

const PBASH = "cd agent/extensions/pi-bridge";
const PVS = "cd pi-vscode";
const HUB = "cd pi-vscode/hub-app";

const tasks = [
  { id: "hub-1", dep: [], title: "Agent: LoadoutGateway (direct YAML CRUD)",
    verify: `${PBASH} && npx vitest run test/loadoutGateway.test.ts`,
    spec: "Create agent/extensions/pi-bridge/loadoutGateway.ts + vitest test. Direct read/write of ~/.pi/capabilities/loadouts.yaml mirroring LoadoutService shape {core,active,loadouts}. Methods: list/get/getActive/snapshot/create/update/addCap/removeCap/remove/setActive. Cap IDs skill:/tool:/mcp:. TDD per plan Task 1." },
  { id: "hub-2", dep: [], title: "Agent: path-allow-listed safeReadFile",
    verify: `${PBASH} && npx vitest run test/safeRead.test.ts`,
    spec: "Create agent/extensions/pi-bridge/safeRead.ts + test. safeReadFile(rawPath, roots) -> {ok,content}|{ok:false,error}; realpathSync + root containment check; reject traversal/out-of-root. Plan Task 2." },
  { id: "hub-3", dep: ["hub-1", "hub-2"], title: "Agent: bridge protocol + handlers (loadout/tool_toggle/read_file)",
    verify: `${PBASH} && npx tsc --noEmit`,
    spec: "Extend protocol.ts (inbound loadout_list/create/update/delete/activate, tool_toggle, read_file; outbound loadouts, file_content). index.ts: wire LoadoutGateway + READ_ROOTS, add switch handlers (reply via {type:response,id,data}, broadcast loadouts after writes; tool_toggle -> setActiveTools + rebuild capabilities; read_file -> safeReadFile). Broadcast loadouts on session_start. Plan Task 3." },
  { id: "hub-4", dep: [], title: "Ext: remove activity-bar sidebar; stub pi.openHub",
    verify: `${PVS} && npx tsc -p tsconfig.json --noEmit`,
    spec: "Delete src/sidebar/{sessions,files,capabilities,stats}.ts. package.json: drop pi-sidebar viewsContainer + views + sidebar menus + onView:* activation; add commands pi.openHub & pi.hub.refresh, keybinding ctrl+shift+alt+p, onCommand:pi.openHub. Prune extension.ts registrations; add temporary pi.openHub stub. Plan Task 4." },
  { id: "hub-5", dep: ["hub-4"], title: "Ext: HubState/Loadout types + bridge events & requests",
    verify: `${PVS} && npx tsc -p tsconfig.json --noEmit`,
    spec: "types.ts: add Loadout, HubState. bridge.ts: emit loadouts & fileContent events; add PiBridgeEvents entries; add typed request helpers listLoadouts/activateLoadout/createLoadout/updateLoadout/deleteLoadout/toggleTool/readFile. Plan Task 5." },
  { id: "hub-6", dep: ["hub-5"], title: "Ext: PiHubStore (aggregate bridge -> HubState)",
    verify: `${PVS} && npx vitest run src/hub/PiHubStore.test.ts`,
    spec: "Create src/hub/PiHubStore.ts + test. Subscribes capabilities/loadouts/fileContent/connected/disconnected; holds HubState; emits 'changed' debounced 50ms with JSON de-dupe. Add vitest devDep + test script if missing. Plan Task 6." },
  { id: "hub-7", dep: ["hub-6"], title: "Ext: PiHubPanel webview wrapper + pi.openHub wiring",
    verify: `${PVS} && npx tsc -p tsconfig.json --noEmit`,
    spec: "Create src/hub/PiHubPanel.ts: createWebviewPanel, load hub-dist/index.html, rewrite ./assets to asWebviewUri, inject CSP+nonce + window.__PI_HUB_UI__, post HubState on store 'changed', route inbound messages (ready/readFile/toggleTool/activate+CRUD loadout/openInEditor/revealDir/persistUi). Wire pi.openHub & pi.hub.refresh in extension.ts; add SessionManager.activeBridge getter if absent. Plan Task 7." },
  { id: "hub-8", dep: ["hub-4"], title: "Hub-app: Svelte 5 + Vite scaffold + build pipeline",
    verify: `${PVS} && npm --prefix hub-app install && npm --prefix hub-app run build && test -f hub-dist/index.html`,
    spec: "Create hub-app/ (package.json, vite.config.ts base './' inlineDynamicImports outDir ../hub-dist, svelte.config.js, tsconfig.json, index.html, src/main.ts, src/App.svelte shell). lib/{bridge.ts,types.ts,theme.css}. Wire pi-vscode package.json compile/prepublish to build hub-app; .vscodeignore excludes hub-app source, includes hub-dist; gitignore hub-dist + hub-app/node_modules. Plan Task 8." },
  { id: "hub-9", dep: ["hub-8"], title: "Hub-app: TabBar + App layout + shared components",
    verify: `${HUB} && npx svelte-check --tsconfig ./tsconfig.json`,
    spec: "Create TabBar.svelte (drag-reorder) + components/{SearchBar,Badge,Dot,ChevronGroup}.svelte. Rewrite App.svelte to host TabBar + active-tab body + footer status; persist tabOrder/activeTab via persistUi/initialUi. Tab bodies are placeholders until Tasks 10-13. Plan Task 9." },
  { id: "hub-10", dep: ["hub-9"], title: "Hub-app: Library tab (tree + search + preview)",
    verify: `${HUB} && npx svelte-check --tsconfig ./tsconfig.json`,
    spec: "Create tabs/LibraryTab.svelte + tabs/DocPreview.svelte; mount in App. Collections tree (ChevronGroup), client fuzzy filter on title+tags, doc click -> post readFile -> preview from state.docContents; Open in Editor + Copy Doc ID. Plan Task 10." },
  { id: "hub-11", dep: ["hub-9"], title: "Hub-app: Skills tab (loadout dots + preview)",
    verify: `${HUB} && npx svelte-check --tsconfig ./tsconfig.json`,
    spec: "Create tabs/SkillsTab.svelte; mount in App. List with Dot filled when skill in active loadout (skill:<name> membership) else hollow; filter; SKILL.md preview via readFile; Open Dir via revealDir. Plan Task 11." },
  { id: "hub-12", dep: ["hub-9"], title: "Hub-app: Tools tab (filter + schema + toggle)",
    verify: `${HUB} && npx svelte-check --tsconfig ./tsconfig.json`,
    spec: "Create tabs/ToolsTab.svelte; mount in App. Filterable list with active check + source Badge + All/Active-only; detail pane with description + JSON schema; toggle -> post toggleTool. Plan Task 12." },
  { id: "hub-13", dep: ["hub-9"], title: "Hub-app: Loadouts tab (activate + CRUD + member edit)",
    verify: `${HUB} && npx svelte-check --tsconfig ./tsconfig.json`,
    spec: "Create tabs/LoadoutTab.svelte; mount in App. List (active marked), member skills/tools by cap-id; Activate/New/Duplicate/Delete; Edit toggles skill membership -> updateLoadout. Plan Task 13." },
  { id: "hub-14", dep: ["hub-3", "hub-7", "hub-10", "hub-11", "hub-12", "hub-13"], title: "Integration: full build, VSIX package, manual smoke + HANDOFF",
    verify: `${PVS} && npx tsc -p tsconfig.json && npm --prefix hub-app run build && npx @vscode/vsce package`,
    spec: "Run agent + extension test suites; full extension build; vsce package (confirm hub-dist included, hub-app source excluded). Manual smoke checklist (open hub, tabs, reorder persist, Library/Skills/Tools/Loadouts round-trips, light+dark theme). Update HANDOFF.md to describe the hub + dropped sidebar. Plan Task 14." },
];

const insert = db.prepare(
  `INSERT INTO tasks(id,project_id,title,spec,prd,priority,status,depends_on,verify,created_by,created_at)
   VALUES(?,?,?,?,?,?,'todo',?,?,?,?)`,
);
const tx = db.transaction(() => {
  tasks.forEach((t, i) => {
    const priority = (tasks.length - i) * 10; // earlier tasks rank higher
    const spec = `${t.spec}\n\nFull steps & code: ${PLAN} -> ${t.title.split(":")[0]}.`;
    insert.run(t.id, PROJECT, t.title, spec, null, priority, JSON.stringify(t.dep), t.verify, "ai", now());
  });
});
tx();

const rows = db.prepare(`SELECT id,title,priority,depends_on FROM tasks WHERE project_id=? ORDER BY priority DESC`).all(PROJECT);
console.log(`Seeded ${rows.length} tasks into project "${PROJECT}":`);
for (const r of rows) console.log(`  ${r.id}  p${r.priority}  deps=${r.depends_on}  ${r.title}`);
