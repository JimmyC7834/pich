import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);

// Resolve the SAME jiti PI uses to load extensions: anchor resolution on PI's
// install dir (its package.json subpath isn't exported, so resolve the main entry
// and search from its directory). Fall back to our own node_modules copy.
let jitiPath;
try {
  const piDir = path.dirname(require.resolve("@earendil-works/pi-coding-agent"));
  jitiPath = require.resolve("jiti", { paths: [piDir] });
} catch {
  jitiPath = require.resolve("jiti");
}

const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(pathToFileURL("./index.ts").href);
const ext = mod.default ?? mod;
const tools = []; const commands = []; const events = [];
ext({ registerTool: (t) => tools.push(t.name), registerCommand: (n) => commands.push(n), on: (e) => events.push(e) });
console.log("LOAD_OK", JSON.stringify({ tools, commands, events }));
if (tools.length !== 5 || events.length !== 3) { console.error("UNEXPECTED SURFACE"); process.exit(1); }
