import { DatabaseSync } from "node:sqlite";
import { DDL } from "./schema.js";
import fs from "node:fs"; import path from "node:path";

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(DDL);
  return db;
}
