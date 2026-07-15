/**
 * Git operations for opencode-worktree-enhanced.
 * All git commands use array-based Bun.spawn to avoid shell injection.
 */
import * as path from "node:path"
import { mkdir } from "node:fs/promises"

// =============================================================================
// RESULT TYPE
// =============================================================================

interface OkResult<T> {
	readonly ok: true
	readonly value: T
}
interface ErrResult<E> {
	readonly ok: false
	readonly error: E
}
export type Result<T, E = string> = OkResult<T> | ErrResult<E>

const Result = {
	ok: <T>(value: T): OkResult<T> => ({ ok: true, value }),
	err: <E>(error: E): ErrResult<E> => ({ ok: false, error }),
}

// =============================================================================
// CORE GIT
// =============================================================================

/**
 * Execute a git command safely using Bun.spawn with explicit array args.
 * Avoids shell interpolation entirely.
 */
export async function git(args: string[], cwd: string): Promise<Result<string>> {
	try {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		})
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		])
		if (exitCode !== 0) {
			return Result.err(stderr.trim() || `git ${args[0]} failed`)
		}
		return Result.ok(stdout.trim())
	} catch (error) {
		return Result.err(error instanceof Error ? error.message : String(error))
	}
}

// =============================================================================
// BRANCH
// =============================================================================

/** Check if a branch exists locally. */
export async function branchExists(cwd: string, branch: string): Promise<boolean> {
	const result = await git(["rev-parse", "--verify", branch], cwd)
	return result.ok
}

// =============================================================================
// WORKTREE
// =============================================================================

/** Resolve the path where a worktree for the given branch will be stored. */
export async function getWorktreePath(
	repoRoot: string,
	branch: string,
	basePath?: string,
): Promise<string> {
	const storage = basePath || path.join(os.homedir(), ".local", "share", "opencode", "worktree")
	// Derive project slug from repo root name
	const projectSlug = path.basename(repoRoot)
	return path.join(storage, projectSlug, branch)
}

// Need os for getWorktreePath
import * as os from "node:os"

/**
 * Create a git worktree.
 * Creates a new branch from baseBranch if the branch doesn't exist yet,
 * or checks out an existing branch into a new worktree.
 */
export async function createWorktree(
	repoRoot: string,
	branch: string,
	baseBranch?: string,
	basePath?: string,
): Promise<Result<string>> {
	const worktreePath = await getWorktreePath(repoRoot, branch, basePath)

	// Ensure parent directory exists
	await mkdir(path.dirname(worktreePath), { recursive: true })

	const exists = await branchExists(repoRoot, branch)

	if (exists) {
		// Checkout existing branch into worktree
		const result = await git(["worktree", "add", worktreePath, branch], repoRoot)
		return result.ok ? Result.ok(worktreePath) : result
	} else {
		// Create new branch from base
		const base = baseBranch ?? "HEAD"
		const result = await git(["worktree", "add", "-b", branch, worktreePath, base], repoRoot)
		return result.ok ? Result.ok(worktreePath) : result
	}
}

/**
 * Remove a git worktree directory.
 * Uses --force as defense-in-depth even when we've validated clean state.
 */
export async function removeWorktree(
	repoRoot: string,
	worktreePath: string,
): Promise<Result<void>> {
	const result = await git(["worktree", "remove", "--force", worktreePath], repoRoot)
	return result.ok ? Result.ok(undefined) : Result.err(result.error)
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Validate that the worktree has no uncommitted changes.
 * Checks `git status --porcelain` — must be empty.
 */
export async function validateWorktreeClean(
	worktreePath: string,
): Promise<Result<void>> {
	const result = await git(["status", "--porcelain"], worktreePath)
	if (!result.ok) {
		return Result.err(`Failed to check worktree status: ${result.error}`)
	}
	if (result.value.length > 0) {
		return Result.err(
			`Worktree has uncommitted changes:\n${result.value}\n\nCommit or stash them before calling \`worktreeDelete\`.`,
		)
	}
	return Result.ok(undefined)
}

/**
 * Validate that a branch is fully merged into a base branch.
 * Uses `git merge-base --is-ancestor` which exits 0 if ancestor (merged).
 */
export async function validateBranchMerged(
	repoRoot: string,
	branch: string,
	baseBranch: string,
): Promise<Result<void>> {
	const result = await git(["merge-base", "--is-ancestor", branch, baseBranch], repoRoot)
	if (!result.ok) {
		return Result.err(
			`Branch "${branch}" is NOT fully merged into "${baseBranch}".\n\n` +
				`Run these steps first:\n` +
				`  1. git checkout ${baseBranch}\n` +
				`  2. git merge ${branch}\n` +
				`  3. Resolve any conflicts\n` +
				`  4. Call \`worktreeDelete\` again`,
		)
	}
	return Result.ok(undefined)
}

// =============================================================================
// LIST
// =============================================================================

/** List all git worktrees. Returns a formatted string. */
export async function listWorktrees(repoRoot: string): Promise<string> {
	const result = await git(["worktree", "list"], repoRoot)
	return result.ok ? result.value : `(failed to list: ${result.error})`
}

/** Delete a local branch (safe delete — git -d refuses if not merged). */
export async function deleteLocalBranch(
	repoRoot: string,
	branch: string,
): Promise<Result<void>> {
	const result = await git(["branch", "-d", branch], repoRoot)
	return result.ok ? Result.ok(undefined) : Result.err(result.error)
}

/** Delete a branch from a remote. Best-effort — may not exist on remote. */
export async function deleteRemoteBranch(
	repoRoot: string,
	branch: string,
	remote: string = "origin",
): Promise<Result<string>> {
	return git(["push", remote, "--delete", branch], repoRoot)
}
