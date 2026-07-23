/**
 * SQLite state database for opencode-worktree-enhanced.
 * Tracks active worktree sessions for the list/delete workflow.
 *
 * The database is stored globally at
 *   ~/.local/share/opencode/plugins/worktree/<project-id>.sqlite
 * keyed by a stable project ID that is the same from any worktree.
 * This ensures ALL sessions (parent + worktree children) share state.
 *
 * Ported from github.com/stevenke1981/opencode-worktree-tools.
 */
import { mkdirSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Database } from "bun:sqlite"
import { getProjectId } from "./project-id"

/** Origin of a worktree session. */
export type SessionSource = "plugin" | "manual"

/** A worktree session record. */
export interface Session {
	id: string
	branch: string
	path: string
	createdAt: string
	source: SessionSource
}

/** A pending-delete record (used when worktree is marked for cleanup). */
interface PendingDelete {
	branch: string
	path: string
}

/** Directory where per-project worktree state databases are stored. */
function getStateDbDir(): string {
	return path.join(os.homedir(), ".local", "share", "opencode", "plugins", "worktree")
}

/**
 * Resolve the global path for this project's worktree state database.
 * Uses `getProjectId()` which produces the same ID from any worktree.
 */
export async function getStateDbPath(projectRoot: string): Promise<string> {
	const projectId = await getProjectId(projectRoot)
	return path.join(getStateDbDir(), `${projectId}.sqlite`)
}

/**
 * Initialize the worktree state SQLite database.
 * Creates the file and tables if they don't exist.
 *
 * The database lives at a GLOBAL location keyed by a stable project ID,
 * so ALL opencode sessions working on the same repo share one DB.
 * This is the key design choice that prevents the "empty DB in worktree"
 * bug — see github.com/stevenke1981/opencode-worktree-tools.
 */
export async function initStateDb(projectRoot: string): Promise<Database> {
	const dbPath = await getStateDbPath(projectRoot)
	mkdirSync(path.dirname(dbPath), { recursive: true })
	const db = new Database(dbPath)
	db.run("PRAGMA journal_mode=WAL")
	db.run(`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		branch TEXT NOT NULL,
		path TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`)
	db.run(`CREATE TABLE IF NOT EXISTS pending_delete (
		branch TEXT PRIMARY KEY,
		path TEXT NOT NULL
	)`)
	runMigrations(db)
	return db
}

// =============================================================================
// SCHEMA MIGRATIONS
// =============================================================================

/**
 * Run schema migrations for the sessions table.
 * Uses a `schema_version` pragma to track which migrations have been applied.
 */
function runMigrations(db: Database): void {
	const version = db.query<{ version: number }, []>("PRAGMA schema_version").get()?.version ?? 0

	if (version < 1) {
		// v1: Add source column (default 'plugin' for backward compat)
		try {
			db.run("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'plugin'")
		} catch {
			// Column may already exist — ignore
		}
		db.run("PRAGMA schema_version = 1")
	}
}

// =============================================================================
// SESSION CRUD
// =============================================================================

/** Add a session to the database. */
export function addSession(
	db: Database,
	session: Session,
): void {
	db.run(
		"INSERT OR REPLACE INTO sessions (id, branch, path, created_at, source) VALUES (?, ?, ?, ?, ?)",
		[session.id, session.branch, session.path, session.createdAt, session.source],
	)
}

/** Remove a session by branch name. */
export function removeSession(
	db: Database,
	branch: string,
): void {
	db.run("DELETE FROM sessions WHERE branch = ?", [branch])
}

function rowToSession(row: Record<string, unknown>): Session {
	return {
		id: String(row.id),
		branch: String(row.branch),
		path: String(row.path),
		createdAt: String(row.created_at),
		source: (row.source as SessionSource) ?? "plugin",
	}
}

/** Get a session by its opencode session ID. */
export function getSession(
	db: Database,
	sessionId: string,
): Session | null {
	const row = db.query("SELECT id, branch, path, created_at, source FROM sessions WHERE id = ?").get(sessionId) as Record<string, unknown> | null
	if (!row) return null
	return rowToSession(row)
}

/** Get a session by worktree path. */
export function getSessionByPath(
	db: Database,
	worktreePath: string,
): Session | null {
	const row = db.query("SELECT id, branch, path, created_at, source FROM sessions WHERE path = ?").get(worktreePath) as Record<string, unknown> | null
	if (!row) return null
	return rowToSession(row)
}

/** Get a session by branch name. */
export function getSessionByBranch(
	db: Database,
	branch: string,
): Session | null {
	const row = db.query("SELECT id, branch, path, created_at, source FROM sessions WHERE branch = ?").get(branch) as Record<string, unknown> | null
	if (!row) return null
	return rowToSession(row)
}

/** Get all sessions. */
export function getAllSessions(
	db: Database,
): Session[] {
	const rows = db.query("SELECT id, branch, path, created_at, source FROM sessions ORDER BY created_at DESC").all() as Record<string, unknown>[]
	return rows.map(rowToSession)
}

// =============================================================================
// PENDING DELETE
// =============================================================================

/** Set a pending delete record. */
export function setPendingDelete(
	db: Database,
	pending: PendingDelete,
): void {
	db.run("INSERT OR REPLACE INTO pending_delete (branch, path) VALUES (?, ?)", [
		pending.branch,
		pending.path,
	])
}

/** Get the current pending delete record, if any. */
export function getPendingDelete(
	db: Database,
): PendingDelete | null {
	const row = db.query("SELECT branch, path FROM pending_delete LIMIT 1").get() as Record<string, unknown> | null
	if (!row) return null
	return {
		branch: String(row.branch),
		path: String(row.path),
	}
}

/** Clear all pending delete records. */
export function clearPendingDelete(db: Database): void {
	db.run("DELETE FROM pending_delete")
}

// =============================================================================
// MANUAL WORKTREE IMPORT
// =============================================================================

/**
 * Import worktrees that exist in git but are not tracked in the session DB.
 * These are worktrees created manually via `git worktree add`.
 *
 * For each worktree entry with a branch:
 *   - Skip if a session with the same path already exists
 *   - Otherwise, insert a new session with source='manual'
 *
 * Returns the number of newly imported sessions.
 */
export function importManualWorktrees(
	db: Database,
	entries: Array<{ path: string; branch: string | null }>,
): number {
	let count = 0
	for (const entry of entries) {
		if (!entry.branch) continue // skip detached HEAD entries

		// Skip if already tracked
		const existing = getSessionByPath(db, entry.path)
		if (existing) continue

		const now = new Date().toISOString()
		const id = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

		addSession(db, {
			id,
			branch: entry.branch,
			path: entry.path,
			createdAt: now,
			source: "manual",
		})
		count++
	}
	return count
}
