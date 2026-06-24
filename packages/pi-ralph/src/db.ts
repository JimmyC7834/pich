import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
const DDL = `
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
  active_run INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  spec TEXT NOT NULL, prd TEXT, priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'todo', depends_on TEXT NOT NULL DEFAULT '[]',
  verify TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, done_at TEXT);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
CREATE TABLE IF NOT EXISTS progress(
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_id TEXT,
  ts TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_progress_project ON progress(project_id, id);
`;

export type DB = DatabaseSync;

export function openRalphDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(DDL);
  return db;
}
