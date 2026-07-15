/**
 * SQLite state database for opencode-worktree-enhanced.
 * Tracks active worktree sessions for the list/delete workflow.
 */
import * as path from "node:path"
import { Database } from "bun:sqlite"

/** A worktree session record. */
export interface Session {
	id: string
	branch: string
	path: string
	createdAt: string
}

/** A pending-delete record (used when worktree is marked for cleanup). */
interface PendingDelete {
	branch: string
	path: string
}

/**
 * Initialize the worktree state SQLite database.
 * Creates the file and tables if they don't exist.
 */
export function initStateDb(root: string): Database {
	const dbPath = path.join(root, ".opencode", "worktree-state.sqlite")
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
	return db
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
		"INSERT OR REPLACE INTO sessions (id, branch, path, created_at) VALUES (?, ?, ?, ?)",
		[session.id, session.branch, session.path, session.createdAt],
	)
}

/** Remove a session by branch name. */
export function removeSession(
	db: Database,
	branch: string,
): void {
	db.run("DELETE FROM sessions WHERE branch = ?", [branch])
}

/** Get a session by its opencode session ID. */
export function getSession(
	db: Database,
	sessionId: string,
): Session | null {
	const row = db.query("SELECT id, branch, path, created_at FROM sessions WHERE id = ?").get(sessionId) as Record<string, unknown> | null
	if (!row) return null
	return {
		id: String(row.id),
		branch: String(row.branch),
		path: String(row.path),
		createdAt: String(row.created_at),
	}
}

/** Get a session by worktree path. */
export function getSessionByPath(
	db: Database,
	worktreePath: string,
): Session | null {
	const row = db.query("SELECT id, branch, path, created_at FROM sessions WHERE path = ?").get(worktreePath) as Record<string, unknown> | null
	if (!row) return null
	return {
		id: String(row.id),
		branch: String(row.branch),
		path: String(row.path),
		createdAt: String(row.created_at),
	}
}

/** Get all sessions. */
export function getAllSessions(
	db: Database,
): Session[] {
	const rows = db.query("SELECT id, branch, path, created_at FROM sessions ORDER BY created_at DESC").all() as Record<string, unknown>[]
	return rows.map((row) => ({
		id: String(row.id),
		branch: String(row.branch),
		path: String(row.path),
		createdAt: String(row.created_at),
	}))
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
