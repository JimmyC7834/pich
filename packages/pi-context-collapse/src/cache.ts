import { DatabaseSync } from "node:sqlite";

export type ContentType = "json" | "log" | "paths" | "useless";

export interface OriginalRecord {
	raw: string;
	toolName: string;
	type: ContentType;
	createdAt: number;
}

/** Default cap on cached originals; oldest are evicted past this to bound growth. */
const DEFAULT_MAX_ENTRIES = 500;

export class OriginalsCache {
	private db: DatabaseSync;
	private readonly maxEntries: number;

	constructor(path = ":memory:", options?: { maxEntries?: number }) {
		this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(`CREATE TABLE IF NOT EXISTS originals (
			hash TEXT PRIMARY KEY,
			raw TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			type TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`);
	}

	save(hash: string, rec: OriginalRecord): void {
		// INSERT OR REPLACE re-inserts an existing hash with a fresh rowid, so
		// re-saving refreshes recency. rowid (insertion order) is the eviction key.
		this.db
			.prepare(
				`INSERT OR REPLACE INTO originals (hash, raw, tool_name, type, created_at) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(hash, rec.raw, rec.toolName, rec.type, rec.createdAt);
		// Evict everything but the newest maxEntries to bound unbounded growth.
		this.db
			.prepare(
				`DELETE FROM originals WHERE rowid NOT IN (SELECT rowid FROM originals ORDER BY rowid DESC LIMIT ?)`,
			)
			.run(this.maxEntries);
	}

	/** Number of cached originals. */
	size(): number {
		return (
			this.db.prepare(`SELECT COUNT(*) AS n FROM originals`).get() as {
				n: number;
			}
		).n;
	}

	get(hash: string): OriginalRecord | undefined {
		const row = this.db
			.prepare(`SELECT raw, tool_name, type, created_at FROM originals WHERE hash = ?`)
			.get(hash) as
			| { raw: string; tool_name: string; type: ContentType; created_at: number }
			| undefined;
		if (!row) return undefined;
		return { raw: row.raw, toolName: row.tool_name, type: row.type, createdAt: row.created_at };
	}

	close(): void {
		this.db.close();
	}
}
