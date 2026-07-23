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
 *
 * Uses a two-tier detection:
 *   1. Commit ancestry (`git merge-base --is-ancestor`) — catches regular merges
 *   2. Content diff (`git diff --quiet`) — catches squash/rebase merges where
 *      the branch tip's tree matches the base tip's tree (no divergence, no
 *      conflict resolution during squash).
 *
 * Neither method is 100% reliable for squash merges (conflict resolution or
 * post-merge divergence can cause the diff check to fail). Callers should
 * offer a `--force` escape hatch when this check fails.
 */
export async function validateBranchMerged(
	repoRoot: string,
	branch: string,
	baseBranch: string,
): Promise<Result<void>> {
	// Tier 1: Fast path — commit ancestry (works for regular merges)
	const ancestorResult = await git(["merge-base", "--is-ancestor", branch, baseBranch], repoRoot)
	if (ancestorResult.ok) return Result.ok(undefined)

	// Tier 2: Content-based check — catches squash/rebase merges where the
	// branch tip's tree is identical to the base tip's tree.
	// `git diff --quiet A..B` exits 0 when the trees at A and B are identical.
	const diffResult = await git(["diff", "--quiet", `${baseBranch}..${branch}`], repoRoot)
	if (diffResult.ok) return Result.ok(undefined)

	return Result.err(
		`Branch "${branch}" is NOT fully merged into "${baseBranch}".\n\n` +
			`Tips:\n` +
			`  - If the branch was merged via squash/rebase, pull the latest ${baseBranch}:\n` +
			`      git checkout ${baseBranch} && git pull\n` +
			`  - If you are certain the branch is safe to delete, use:\n` +
			`      worktreeDelete --force\n` +
			`  - Otherwise, merge the branch first:\n` +
			`      git checkout ${baseBranch} && git merge ${branch}`,
	)
}

// =============================================================================
// LIST
// =============================================================================

/**
 * Resolve the main repository root directory.
 *
 * From a git worktree, returns the main repo's root (the original checkout).
 * From the main repo itself, returns the repo root.
 *
 * Detection: in a worktree, `git rev-parse --git-dir` returns a path containing
 * `/worktrees/` (e.g. `/path/to/main/.git/worktrees/<name>`).
 * In the main repo, it returns `.git` or `/path/to/main/.git`.
 */
export async function getMainRepoRoot(cwd: string): Promise<string | null> {
	const gitDirResult = await git(["rev-parse", "--git-dir"], cwd)
	if (!gitDirResult.ok) return null

	const gitDir = gitDirResult.value
	// Inside a worktree, git-dir is <main>/.git/worktrees/<name>
	// The presence of /worktrees/ in the git-dir path indicates a worktree
	if (gitDir.includes("/worktrees/")) {
		// git-dir may be relative (e.g. ".git/worktrees/foo")
		// Resolve it relative to cwd, then walk up from .git/worktrees/<name> → <main>
		const absGitDir = path.resolve(cwd, gitDir)
		return path.resolve(absGitDir, "../../..")
	}

	// In the main repo, show-toplevel gives us the root
	const topLevel = await git(["rev-parse", "--show-toplevel"], cwd)
	return topLevel.ok ? topLevel.value : null
}

/** A single worktree entry from --porcelain output. */
export interface WorktreeEntry {
	path: string
	/** Branch name without refs/heads/ prefix, or null for detached HEAD */
	branch: string | null
}

/** List all git worktrees. Returns a formatted string. */
export async function listWorktrees(repoRoot: string): Promise<string> {
	const result = await git(["worktree", "list"], repoRoot)
	return result.ok ? result.value : `(failed to list: ${result.error})`
}

/**
 * List all git worktrees using --porcelain for stable machine parsing.
 *
 * Output format:
 *   worktree /path/to/worktree
 *   HEAD abc1234...
 *   branch refs/heads/feature/foo
 *   <blank line>
 *
 * For detached HEAD or bare repos, the `branch` field is absent or `detached`/`(bare)`.
 */
export async function listWorktreesPorcelain(repoRoot: string): Promise<Result<WorktreeEntry[]>> {
	const result = await git(["worktree", "list", "--porcelain"], repoRoot)
	if (!result.ok) return result

	const entries: WorktreeEntry[] = []
	let current: Partial<WorktreeEntry> = {}

	for (const line of result.value.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) {
				entries.push(current as WorktreeEntry)
			}
			current = { path: line.slice(9) }
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice(7).replace(/^refs\/heads\//, "")
		} else if (line === "") {
			if (current.path) {
				entries.push(current as WorktreeEntry)
			}
			current = {}
		}
	}
	if (current.path) {
		entries.push(current as WorktreeEntry)
	}

	return Result.ok(entries)
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

// =============================================================================
// PENDING WORKTREE CLEANUP
// =============================================================================

/** Result of a pending worktree cleanup operation. */
export interface CleanupResult {
	/** True if at least one step succeeded. */
	ok: boolean
	/** Whether the worktree directory was removed. */
	worktreeRemoved: boolean
	/** Whether the local branch was deleted. */
	localBranchDeleted: boolean
	/** Whether the remote branch was deleted (at least one remote). */
	remoteBranchDeleted: boolean
	/** Non-fatal errors collected during cleanup. */
	errors: string[]
}

/**
 * Clean up a worktree that was previously marked for pending deletion.
 *
 * Best-effort: attempts to remove the worktree directory, delete local branch,
 * and delete remote branches. Continues on failure — partial cleanup is still
 * useful (e.g., worktree removed but branch left behind is easy to fix).
 *
 * All git commands use `mainRepoRoot` as CWD so they never fail due to
 * the worktree directory being removed mid-operation.
 */
export async function cleanupPendingWorktree(
	mainRepoRoot: string,
	branch: string,
	worktreePath: string,
	log?: (msg: string) => void,
): Promise<CleanupResult> {
	const errors: string[] = []

	// 1. Remove worktree directory
	const removeResult = await removeWorktree(mainRepoRoot, worktreePath)
	const worktreeRemoved = removeResult.ok
	if (!worktreeRemoved && removeResult.error) {
		// "not a valid worktree" means it's already gone — not an error
		if (
			!removeResult.error.includes("not a working tree") &&
			!removeResult.error.includes("not a valid worktree") &&
			!removeResult.error.includes("does not exist")
		) {
			errors.push(`Worktree removal: ${removeResult.error}`)
		} else {
			log?.("Worktree already gone — skipping")
		}
	}

	// 2. Delete local branch (safe delete — git -d refuses if not merged)
	const branchResult = await deleteLocalBranch(mainRepoRoot, branch)
	const localBranchDeleted = branchResult.ok
	if (!localBranchDeleted && branchResult.error) {
		if (
			!branchResult.error.includes("not found") &&
			!branchResult.error.includes("did not match")
		) {
			errors.push(`Local branch deletion: ${branchResult.error}`)
		} else {
			log?.("Branch already gone — skipping")
		}
	}

	// 3. Delete remote branches (best-effort)
	let remoteBranchDeleted = false
	const remoteResult = await git(["remote"], mainRepoRoot)
	if (remoteResult.ok && remoteResult.value.trim()) {
		const remotes = remoteResult.value.split("\n").filter((r) => r.trim())
		for (const remote of remotes) {
			const pushDeleteResult = await deleteRemoteBranch(mainRepoRoot, branch, remote)
			if (pushDeleteResult.ok) {
				remoteBranchDeleted = true
			} else {
				const err = pushDeleteResult.error ?? ""
				if (
					err.includes("remote ref does not exist") ||
					err.includes("could not delete") ||
					err.includes("not match")
				) {
					log?.(`Remote branch ${remote}/${branch} did not exist — skipping`)
				} else {
					errors.push(`Remote branch deletion (${remote}/${branch}): ${err}`)
				}
			}
		}
	}

	return {
		ok: worktreeRemoved || localBranchDeleted || errors.length === 0,
		worktreeRemoved,
		localBranchDeleted,
		remoteBranchDeleted,
		errors,
	}
}
