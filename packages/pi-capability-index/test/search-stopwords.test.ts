import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { capabilitySearch } from "../src/search.js";

// Regression: stopwords must not drive ranking. Before the fix, OR-ing every
// token let a common-word-heavy capability win regardless of the real intent.
test("meaningful term outranks a stopword-heavy decoy", () => {
  const db = openDb(":memory:");
  const ins = (id: string, name: string, summary: string) => {
    db.prepare("INSERT INTO capability(id,kind,name,summary) VALUES (?,?,?,?)").run(id, "tool", name, summary);
    db.prepare("INSERT INTO capability_fts(id,name,summary,params) VALUES (?,?,?,?)").run(id, name, summary, "");
  };
  ins("edit", "edit_file", "edit a file on disk");
  ins("decoy", "decoy", "how do I do the thing with a or an and to of");
  const r = capabilitySearch(db, "how do I edit a file", { kind: "all", k: 2 });
  expect(r.hits[0].id).toBe("edit");
});
