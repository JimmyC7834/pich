// End-to-end harness for code-vocab-wire.ts.
// Loads the extension with a mock `pi`, then drives session_start +
// before_agent_start against throwaway git repos (a code repo and a non-code
// repo). Run with:  node --experimental-strip-types wire.harness.mjs
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXT = pathToFileURL(path.join(os.homedir(), ".pi", "agent", "extensions", "code-vocab-wire.ts")).href;

function sh(cmd, args, cwd) { execFileSync(cmd, args, { cwd, stdio: "pipe" }); }
function mkRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  sh("git", ["init", "-q"], dir);
  sh("git", ["config", "user.email", "t@t"], dir);
  sh("git", ["config", "user.name", "t"], dir);
  sh("git", ["add", "-A"], dir);
  sh("git", ["commit", "-qm", "init"], dir);
  return dir;
}

// Mock pi that records handlers + registered tools.
function mockPi() {
  const handlers = {}, tools = {};
  return {
    handlers, tools,
    on: (ev, fn) => { handlers[ev] = fn; },
    registerTool: (t) => { tools[t.name] = t; },
  };
}

let pass = 0, fail = 0;
function check(name, cond) { cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ FAIL: " + name)); }

const factory = (await import(EXT)).default;

// ---- Case 1: a code repo ----
console.log("\n[Case 1] code repo");
{
  const repo = mkRepo({
    "src/app.ts": "export function startServer() { return 42; }\nexport class Widget {}\n",
    "src/util.ts": "export function helper() { return startServer(); }\n",
    "README.md": "# demo\n",
  });
  const cwd0 = process.cwd();
  process.chdir(repo);
  try {
    const pi = mockPi();
    factory(pi);
    await pi.handlers["session_start"]();
    const art = path.join(repo, ".pi", "code-vocab");
    check("artifact dir created", fs.existsSync(art));
    check("vocabulary.md written", fs.existsSync(path.join(art, "vocabulary.md")));
    check("meta.json written", fs.existsSync(path.join(art, "meta.json")));
    check(".gitignore written in artifact dir", fs.existsSync(path.join(art, ".gitignore")));
    check("artifact dir is git-ignored", (() => {
      try { sh("git", ["check-ignore", "-q", ".pi/code-vocab/tags.json"], repo); return true; } catch { return false; }
    })());

    const r = await pi.handlers["before_agent_start"]({ systemPrompt: "BASE_PROMPT" });
    check("before_agent_start returns systemPrompt", !!r && typeof r.systemPrompt === "string");
    check("injected on top of base", r && r.systemPrompt.startsWith("BASE_PROMPT"));
    check("contains atlas header", r && r.systemPrompt.includes("## Folder atlas"));
    check("contains usage contract", r && r.systemPrompt.includes("Codebase atlas + lookup"));
    check("contract mentions vocab_find tool", r && r.systemPrompt.includes("`vocab_find`"));

    // The wrapper tools.
    check("vocab_find tool registered", !!pi.tools["vocab_find"]);
    check("vocab_usages tool registered", !!pi.tools["vocab_usages"]);
    const fr = await pi.tools["vocab_find"].execute("t", { query: "startServer" });
    const ftext = fr.content[0].text;
    check("vocab_find returns file:line for the definition", /app\.ts:\d+/.test(ftext) && ftext.includes("startServer"));
    const ur = await pi.tools["vocab_usages"].execute("t", { query: "startServer" });
    const utext = ur.content[0].text;
    check("vocab_usages finds the call-site (util.ts)", /util\.ts:\d+/.test(utext));

    // Idempotent rebuild skip: second session_start with no changes must NOT rebuild.
    const before = fs.statSync(path.join(art, "vocabulary.md")).mtimeMs;
    await new Promise((res) => setTimeout(res, 30));
    await pi.handlers["session_start"]();
    const after = fs.statSync(path.join(art, "vocabulary.md")).mtimeMs;
    check("unchanged repo → skips rebuild (mtime stable)", before === after);

    // After an edit, signal changes → rebuild happens.
    fs.writeFileSync(path.join(repo, "src/new.ts"), "export function added() {}\n");
    sh("git", ["add", "-A"], repo);
    await pi.handlers["session_start"]();
    const after2 = fs.statSync(path.join(art, "vocabulary.md")).mtimeMs;
    check("changed repo → rebuilds (mtime advances)", after2 > after);
  } finally { process.chdir(cwd0); fs.rmSync(repo, { recursive: true, force: true }); }
}

// ---- Case 2: a non-code repo (Option B) ----
console.log("\n[Case 2] non-code repo (Option B)");
{
  const repo = mkRepo({ "README.md": "# notes\nprose only\n", "docs/a.txt": "hi\n" });
  const cwd0 = process.cwd();
  process.chdir(repo);
  try {
    const pi = mockPi();
    factory(pi);
    await pi.handlers["session_start"]();
    check("no artifact dir kept (Option B)", !fs.existsSync(path.join(repo, ".pi", "code-vocab")));
    const r = await pi.handlers["before_agent_start"]({ systemPrompt: "BASE" });
    check("no injection for non-code repo", r === undefined);
  } finally { process.chdir(cwd0); fs.rmSync(repo, { recursive: true, force: true }); }
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
