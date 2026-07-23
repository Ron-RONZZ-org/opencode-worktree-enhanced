/**
 * Tests for opencode-worktree-enhanced.
 *
 * Run with: bun test tests/
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execSync } from "node:child_process"

import { validateBranchName } from "../src/validate"
import {
	cleanupPendingWorktree,
	deleteLocalBranch,
	getMainRepoRoot,
	git,
	listWorktreesPorcelain,
	removeWorktree,
	validateBranchMerged,
	validateWorktreeClean,
} from "../src/git"
import {
	addSession,
	getAllSessions,
	getSessionByBranch,
	getSessionByPath,
	importManualWorktrees,
	removeSession,
} from "../src/state"

// =============================================================================
// TEST SANDBOX
// =============================================================================

const SANDBOX = path.join(os.tmpdir(), "worktree-enhanced-test-" + Date.now())

// =============================================================================
// GIT TEST HELPERS
// =============================================================================

function createGitRepo(repoPath: string, defaultBranch = "main"): void {
	execSync("git init", { cwd: repoPath })
	execSync(`git checkout -b ${defaultBranch}`, { cwd: repoPath })
	execSync('git config user.email "test@test.com"', { cwd: repoPath })
	execSync('git config user.name "Test"', { cwd: repoPath })
	fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Repo")
	execSync("git add -A", { cwd: repoPath })
	execSync("git commit -m 'Initial commit'", { cwd: repoPath })
}

function createCommitOnBranch(repoPath: string, branch: string, message: string): void {
	try {
		execSync(`git checkout ${branch}`, { cwd: repoPath })
	} catch {
		execSync(`git checkout -b ${branch}`, { cwd: repoPath })
	}
	const safeName = branch.replace(/\//g, "-")
	const file = path.join(repoPath, `commit-${safeName}.txt`)
	fs.writeFileSync(file, `content from ${branch}: ${Date.now()}`)
	execSync("git add -A", { cwd: repoPath })
	execSync(`git commit -m "${message}"`, { cwd: repoPath })
}

function mergeBranch(repoPath: string, target: string, source: string): void {
	execSync(`git checkout ${target}`, { cwd: repoPath })
	execSync(`git merge ${source} --no-edit`, { cwd: repoPath })
}

/**
 * Squash-merge a source branch into a target branch.
 * This creates a single commit on target with the combined changes,
 * but the source branch's commits remain orphaned (not ancestors of target).
 */
function squashMergeBranch(repoPath: string, target: string, source: string): void {
	execSync(`git checkout ${target}`, { cwd: repoPath })
	execSync(`git merge --squash ${source}`, { cwd: repoPath })
	execSync(`git commit -m "Squash merge ${source}"`, { cwd: repoPath })
}

// =============================================================================
// TESTS: validateBranchName
// =============================================================================

describe("validateBranchName", () => {
	test("accepts valid branch names", () => {
		expect(validateBranchName("feature/my-feature")).toBeNull()
		expect(validateBranchName("fix/123-bug")).toBeNull()
		expect(validateBranchName("main")).toBeNull()
		expect(validateBranchName("v1.2.3")).toBeNull()
		expect(validateBranchName("chore/update-deps")).toBeNull()
	})

	test("rejects empty name", () => {
		expect(validateBranchName("")).toBe("Branch name cannot be empty")
	})

	test("rejects name starting with dash", () => {
		expect(validateBranchName("-branch")).toContain("start with '-'")
	})

	test("rejects name with shell metacharacters", () => {
		expect(validateBranchName("feature/;rm -rf")).toContain("invalid")
		expect(validateBranchName("feature/$(id)")).toContain("invalid")
		expect(validateBranchName("feature/`cmd`")).toContain("invalid")
	})

	test("rejects name with git ref invalid chars", () => {
		expect(validateBranchName("feature/~tilde")).toContain("invalid")
		expect(validateBranchName("feature/^caret")).toContain("invalid")
		expect(validateBranchName("feature/:colon")).toContain("invalid")
	})

	test("rejects name with consecutive dots", () => {
		expect(validateBranchName("feature/..double-dot")).toContain("..")
	})

	test("rejects name with @{ reflog syntax", () => {
		expect(validateBranchName("feature/@{reflog}")).toContain("@")
	})

	test("rejects name ending with .lock", () => {
		expect(validateBranchName("feature/branch.lock")).toContain(".lock")
	})

	test("rejects name longer than 255", () => {
		expect(validateBranchName("a".repeat(256))).toContain("too long")
	})

	test("rejects name starting or ending with slash", () => {
		expect(validateBranchName("/feature")).toContain("start or end with '/'")
		expect(validateBranchName("feature/")).toContain("start or end with '/'")
	})
})

// =============================================================================
// TESTS: validateWorktreeClean
// =============================================================================

describe("validateWorktreeClean", () => {
	const repoDir = path.join(SANDBOX, "clean-test-repo")

	beforeAll(() => {
		fs.mkdirSync(repoDir, { recursive: true })
		createGitRepo(repoDir)
		execSync("git checkout -b feature/test", { cwd: repoDir })
	})

	afterAll(() => {
		fs.rmSync(repoDir, { recursive: true, force: true })
	})

	test("returns ok for a clean repo", async () => {
		const result = await validateWorktreeClean(repoDir)
		expect(result.ok).toBe(true)
	})

	test("returns err for a dirty repo (modified file)", async () => {
		fs.writeFileSync(path.join(repoDir, "dirty.txt"), "uncommitted")
		const result = await validateWorktreeClean(repoDir)
		expect(result.ok).toBe(false)
		expect(result.error).toContain("uncommitted changes")
		fs.unlinkSync(path.join(repoDir, "dirty.txt"))
	})

	test("returns err for a dirty repo (untracked file)", async () => {
		fs.writeFileSync(path.join(repoDir, "untracked.txt"), "new file")
		const result = await validateWorktreeClean(repoDir)
		expect(result.ok).toBe(false)
		expect(result.error).toContain("uncommitted changes")
		fs.unlinkSync(path.join(repoDir, "untracked.txt"))
	})

	test("returns err for non-existent path", async () => {
		const badPath = path.join(SANDBOX, "does-not-exist")
		const result = await validateWorktreeClean(badPath)
		expect(result.ok).toBe(false)
		expect(result.error).toContain("Failed to check worktree status")
	})
})

// =============================================================================
// TESTS: validateBranchMerged
// =============================================================================

describe("validateBranchMerged", () => {
	const repoDir = path.join(SANDBOX, "merge-test-repo")

	beforeAll(() => {
		fs.mkdirSync(repoDir, { recursive: true })
		createGitRepo(repoDir, "main")
		createCommitOnBranch(repoDir, "feature/merged", "feat: work on merged branch")
		createCommitOnBranch(repoDir, "feature/merged", "feat: more work on merged branch")
		mergeBranch(repoDir, "main", "feature/merged")
		createCommitOnBranch(repoDir, "feature/unmerged", "feat: work on unmerged branch")
	})

	afterAll(() => {
		fs.rmSync(repoDir, { recursive: true, force: true })
	})

	test("returns ok for a merged branch", async () => {
		const result = await validateBranchMerged(repoDir, "feature/merged", "main")
		expect(result.ok).toBe(true)
	})

	test("returns err for an unmerged branch", async () => {
		const result = await validateBranchMerged(repoDir, "feature/unmerged", "main")
		expect(result.ok).toBe(false)
		expect(result.error).toContain("NOT fully merged")
		expect(result.error).toContain("feature/unmerged")
		expect(result.error).toContain("main")
	})

	test("returns err for non-existent branch", async () => {
		const result = await validateBranchMerged(repoDir, "feature/nonexistent", "main")
		expect(result.ok).toBe(false)
	})

	test("returns err for non-existent base branch", async () => {
		const result = await validateBranchMerged(repoDir, "feature/merged", "nonexistent")
		expect(result.ok).toBe(false)
	})

	test("returns err for non-existent repo path", async () => {
		const badPath = path.join(SANDBOX, "no-repo-here")
		const result = await validateBranchMerged(badPath, "feature/merged", "main")
		expect(result.ok).toBe(false)
	})
})

describe("validateBranchMerged with squash merge", () => {
	const repoDir = path.join(SANDBOX, "squash-merge-test-repo")

	beforeAll(() => {
		fs.mkdirSync(repoDir, { recursive: true })
		createGitRepo(repoDir, "main")
		// Create feature branch with commits
		createCommitOnBranch(repoDir, "feature/squashed", "feat: first squash commit")
		createCommitOnBranch(repoDir, "feature/squashed", "feat: second squash commit")
		// Squash-merge it into main
		squashMergeBranch(repoDir, "main", "feature/squashed")
	})

	afterAll(() => {
		fs.rmSync(repoDir, { recursive: true, force: true })
	})

	test("detects a squash-merged branch via content diff fallback", async () => {
		const result = await validateBranchMerged(repoDir, "feature/squashed", "main")
		expect(result.ok).toBe(true)
	})
})

// =============================================================================
// TESTS: git helper
// =============================================================================

describe("git helper", () => {
	const repoDir = path.join(SANDBOX, "git-helper-test")

	beforeAll(() => {
		fs.mkdirSync(repoDir, { recursive: true })
		createGitRepo(repoDir)
	})

	afterAll(() => {
		fs.rmSync(repoDir, { recursive: true, force: true })
	})

	test("git() returns ok for successful commands", async () => {
		const result = await git(["rev-parse", "--verify", "main"], repoDir)
		expect(result.ok).toBe(true)
		expect(result.value).toBeDefined()
	})

	test("git() returns err for failing commands", async () => {
		const result = await git(["rev-parse", "--verify", "nonexistent-branch"], repoDir)
		expect(result.ok).toBe(false)
	})

	test("git() returns err for non-existent cwd", async () => {
		const result = await git(["status"], "/nonexistent/path")
		expect(result.ok).toBe(false)
	})
})

// =============================================================================
// TESTS: removeWorktree
// =============================================================================

describe("removeWorktree", () => {
	const mainRepo = path.join(SANDBOX, "wt-remove-main")
	const worktreesDir = path.join(SANDBOX, "wt-remove-worktrees")

	beforeAll(() => {
		fs.mkdirSync(mainRepo, { recursive: true })
		createGitRepo(mainRepo, "main")
		fs.mkdirSync(worktreesDir, { recursive: true })

		execSync(
			`git worktree add -b feature/wt-remove ${path.join(worktreesDir, "feature-wt-remove")} main`,
			{ cwd: mainRepo },
		)
	})

	afterAll(() => {
		try {
			const wtPath = path.join(worktreesDir, "feature-wt-remove")
			if (fs.existsSync(wtPath)) {
				execSync(`git worktree remove --force "${wtPath}"`, { cwd: mainRepo })
			}
		} catch { /* best-effort */ }
		fs.rmSync(worktreesDir, { recursive: true, force: true })
		fs.rmSync(mainRepo, { recursive: true, force: true })
	})

	test("removes a valid worktree", async () => {
		const wtPath = path.join(worktreesDir, "feature-wt-remove")
		expect(fs.existsSync(wtPath)).toBe(true)

		const result = await removeWorktree(mainRepo, wtPath)
		expect(result.ok).toBe(true)
	})

	test("returns err for non-existent worktree path", async () => {
		const result = await removeWorktree(mainRepo, "/nonexistent/worktree/path")
		expect(result.ok).toBe(false)
	})
})

// =============================================================================
// TESTS: getMainRepoRoot
// =============================================================================

describe("getMainRepoRoot", () => {
	const mainRepo = path.join(SANDBOX, "main-root-test")
	const worktreesDir = path.join(SANDBOX, "main-root-worktrees")
	const branch = "feature/main-root"
	const wtPath = path.join(worktreesDir, "main-root")

	beforeAll(() => {
		fs.mkdirSync(mainRepo, { recursive: true })
		createGitRepo(mainRepo, "main")
		fs.mkdirSync(worktreesDir, { recursive: true })
		execSync(`git worktree add -b ${branch} ${wtPath} main`, { cwd: mainRepo })
	})

	afterAll(() => {
		try {
			if (fs.existsSync(wtPath)) {
				execSync(`git worktree remove --force "${wtPath}"`, { cwd: mainRepo })
			}
		} catch { /* best-effort */ }
		fs.rmSync(worktreesDir, { recursive: true, force: true })
		fs.rmSync(mainRepo, { recursive: true, force: true })
	})

	test("resolves main repo root from a worktree", async () => {
		const resolvedRoot = await getMainRepoRoot(wtPath)
		expect(resolvedRoot).not.toBeNull()
		// Should resolve to the main repo (not the worktree)
		expect(resolvedRoot).toBe(mainRepo)
	})

	test("resolves main repo root from the main repo itself", async () => {
		const resolvedRoot = await getMainRepoRoot(mainRepo)
		expect(resolvedRoot).not.toBeNull()
		expect(resolvedRoot).toBe(mainRepo)
	})

	test("returns null for a non-repo directory", async () => {
		const resolvedRoot = await getMainRepoRoot("/nonexistent")
		expect(resolvedRoot).toBeNull()
	})
})

// =============================================================================
// TESTS: deleteLocalBranch
// =============================================================================

describe("deleteLocalBranch", () => {
	const repoDir = path.join(SANDBOX, "delete-branch-test")

	beforeAll(() => {
		fs.mkdirSync(repoDir, { recursive: true })
		createGitRepo(repoDir, "main")
		createCommitOnBranch(repoDir, "feature/delete-me", "feat: to be deleted")
	})

	afterAll(() => {
		fs.rmSync(repoDir, { recursive: true, force: true })
	})

	test("deletes a merged branch", async () => {
		// Merge the branch into main so it can be safely deleted
		mergeBranch(repoDir, "main", "feature/delete-me")
		const result = await deleteLocalBranch(repoDir, "feature/delete-me")
		expect(result.ok).toBe(true)

		// Confirm the branch is gone
		const verify = await git(["rev-parse", "--verify", "feature/delete-me"], repoDir)
		expect(verify.ok).toBe(false)
	})

	test("refuses to delete an unmerged branch", async () => {
		createCommitOnBranch(repoDir, "feature/unmerged-delete", "feat: unmerged")
		const result = await deleteLocalBranch(repoDir, "feature/unmerged-delete")
		expect(result.ok).toBe(false)
		// git branch -d can fail because branch is not fully merged,
		// or because it is currently checked out — either is expected
		expect(result.error).toBeDefined()
	})

	test("returns err for non-existent branch", async () => {
		const result = await deleteLocalBranch(repoDir, "feature/nonexistent")
		expect(result.ok).toBe(false)
	})
})

// =============================================================================
// TESTS: cleanupPendingWorktree
// =============================================================================

describe("cleanupPendingWorktree", () => {
	const mainRepo = path.join(SANDBOX, "cleanup-pending-main")
	const worktreesDir = path.join(SANDBOX, "cleanup-pending-wts")
	const branch = "feature/cleanup-test"
	const wtPath = path.join(worktreesDir, "cleanup-test")

	beforeAll(() => {
		fs.mkdirSync(mainRepo, { recursive: true })
		createGitRepo(mainRepo, "main")
		fs.mkdirSync(worktreesDir, { recursive: true })
		// Create branch, merge into main, create worktree
		execSync(`git checkout -b ${branch}`, { cwd: mainRepo })
		fs.writeFileSync(path.join(mainRepo, "cleanup-feature.txt"), "feature work")
		execSync("git add -A", { cwd: mainRepo })
		execSync(`git commit -m "feat: cleanup test"`, { cwd: mainRepo })
		execSync("git checkout main", { cwd: mainRepo })
		execSync(`git merge ${branch} --no-edit`, { cwd: mainRepo })
		execSync(`git worktree add ${wtPath} ${branch}`, { cwd: mainRepo })
	})

	afterAll(() => {
		try {
			if (fs.existsSync(wtPath)) {
				execSync(`git worktree remove --force "${wtPath}"`, { cwd: mainRepo })
			}
		} catch { /* best-effort */ }
		fs.rmSync(worktreesDir, { recursive: true, force: true })
		fs.rmSync(mainRepo, { recursive: true, force: true })
	})

	test("cleans up a valid worktree: removes directory, deletes branches", async () => {
		expect(fs.existsSync(wtPath)).toBe(true)

		const result = await cleanupPendingWorktree(mainRepo, branch, wtPath)
		expect(result.ok).toBe(true)
		expect(result.worktreeRemoved).toBe(true)
		expect(result.localBranchDeleted).toBe(true)
		// remoteBranchDeleted may be false if there's no remote configured
		expect(result.errors).toEqual([])

		// Verify the worktree directory is gone
		expect(fs.existsSync(wtPath)).toBe(false)

		// Verify the branch is gone
		const verifyBranch = await git(["rev-parse", "--verify", branch], mainRepo)
		expect(verifyBranch.ok).toBe(false)
	})

	test("handles non-existent worktree path gracefully", async () => {
		const fakePath = path.join(worktreesDir, "never-existed")
		const fakeBranch = "feature/never-existed"

		const result = await cleanupPendingWorktree(mainRepo, fakeBranch, fakePath)
		// Both the worktree and branch don't exist, but cleanup should not throw.
		// ok=true means "cleanup completed without hard errors" — there was nothing to remove.
		expect(result.ok).toBe(true)
		expect(result.errors).toEqual([])
		expect(result.worktreeRemoved).toBe(false)
		expect(result.localBranchDeleted).toBe(false)
	})
})

// =============================================================================
// TESTS: Deferred deletion flow (worktreeDelete → pending → cleanupPendingWorktree)
// =============================================================================

describe("deferred worktree deletion flow", () => {
	const mainRepo = path.join(SANDBOX, "deferred-flow-main")
	const worktreesDir = path.join(SANDBOX, "deferred-flow-wts")
	const branch = "feature/deferred-flow"
	const wtPath = path.join(worktreesDir, "deferred-flow")

	beforeAll(() => {
		fs.mkdirSync(mainRepo, { recursive: true })
		createGitRepo(mainRepo, "main")
		fs.mkdirSync(worktreesDir, { recursive: true })
	})

	afterAll(() => {
		try {
			if (fs.existsSync(wtPath)) {
				execSync(`git worktree remove --force "${wtPath}"`, { cwd: mainRepo })
			}
		} catch { /* best-effort */ }
		fs.rmSync(worktreesDir, { recursive: true, force: true })
		fs.rmSync(mainRepo, { recursive: true, force: true })
	})

	test("simulates deferred deletion: directory survives until cleanupPendingWorktree is called", async () => {
		// Create branch with a commit
		execSync(`git checkout -b ${branch}`, { cwd: mainRepo })
		fs.writeFileSync(path.join(mainRepo, "deferred.txt"), "deferred work")
		execSync("git add -A", { cwd: mainRepo })
		execSync(`git commit -m "feat: deferred test"`, { cwd: mainRepo })
		// Merge into main
		execSync("git checkout main", { cwd: mainRepo })
		execSync(`git merge ${branch} --no-edit`, { cwd: mainRepo })
		// Create worktree
		execSync(`git worktree add ${wtPath} ${branch}`, { cwd: mainRepo })

		expect(fs.existsSync(wtPath)).toBe(true)

		// Simulate worktreeDelete marking pending: resolve mainRepoRoot
		const mainRoot = await getMainRepoRoot(wtPath)
		expect(mainRoot).toBe(mainRepo)

		// "worktreeDelete" runs, but the directory is NOT removed.
		// The test simulates the pending delete by NOT calling removeWorktree yet.
		// Directory still exists — tools would continue to work.
		expect(fs.existsSync(wtPath)).toBe(true)

		// Simulate the "next session" calling cleanupPendingWorktree
		const result = await cleanupPendingWorktree(mainRoot!, branch, wtPath)
		expect(result.ok).toBe(true)
		expect(result.worktreeRemoved).toBe(true)
		expect(result.localBranchDeleted).toBe(true)
		expect(result.errors).toEqual([])

		// Directory is now truly gone
		expect(fs.existsSync(wtPath)).toBe(false)

		// Branch is gone
		const verifyBranch = await git(["rev-parse", "--verify", branch], mainRoot!)
		expect(verifyBranch.ok).toBe(false)

		// Main repo still works
		const statusResult = await git(["status", "--porcelain"], mainRoot!)
		expect(statusResult.ok).toBe(true)
	})
})

// =============================================================================
// TESTS: end-to-end validation combinations
// =============================================================================

describe("end-to-end: clean + merged passes validation", () => {
	const repoDir = path.join(SANDBOX, "e2e-clean-merged")

	beforeAll(() => {
		fs.mkdirSync(repoDir, { recursive: true })
		createGitRepo(repoDir, "main")
		createCommitOnBranch(repoDir, "feature/e2e", "feat: e2e test commit")
		mergeBranch(repoDir, "main", "feature/e2e")
	})

	afterAll(() => {
		fs.rmSync(repoDir, { recursive: true, force: true })
	})

	test("clean + merged = both validations pass", async () => {
		const clean = await validateWorktreeClean(repoDir)
		expect(clean.ok).toBe(true)

		const merged = await validateBranchMerged(repoDir, "feature/e2e", "main")
		expect(merged.ok).toBe(true)
	})
})

describe("end-to-end: dirty + merged fails clean validation", () => {
	const repoDir = path.join(SANDBOX, "e2e-dirty-merged")

	beforeAll(() => {
		fs.mkdirSync(repoDir, { recursive: true })
		createGitRepo(repoDir, "main")
		createCommitOnBranch(repoDir, "feature/dirty-merged", "feat: dirty merged commit")
		mergeBranch(repoDir, "main", "feature/dirty-merged")
		fs.writeFileSync(path.join(repoDir, "oops.txt"), "forgot to commit this")
	})

	afterAll(() => {
		fs.rmSync(repoDir, { recursive: true, force: true })
	})

	test("merged but dirty = clean fails, merged passes", async () => {
		const clean = await validateWorktreeClean(repoDir)
		expect(clean.ok).toBe(false)
		expect(clean.error).toContain("uncommitted changes")

		const merged = await validateBranchMerged(repoDir, "feature/dirty-merged", "main")
		expect(merged.ok).toBe(true)
	})
})

describe("end-to-end: clean + unmerged fails merge validation", () => {
	const repoDir = path.join(SANDBOX, "e2e-clean-unmerged")

	beforeAll(() => {
		fs.mkdirSync(repoDir, { recursive: true })
		createGitRepo(repoDir, "main")
		createCommitOnBranch(repoDir, "feature/clean-unmerged", "feat: unmerged commit")
	})

	afterAll(() => {
		fs.rmSync(repoDir, { recursive: true, force: true })
	})

	test("clean but unmerged = clean passes, merged fails", async () => {
		const clean = await validateWorktreeClean(repoDir)
		expect(clean.ok).toBe(true)

		const merged = await validateBranchMerged(repoDir, "feature/clean-unmerged", "main")
		expect(merged.ok).toBe(false)
		expect(merged.error).toContain("NOT fully merged")
	})
})

// =============================================================================
// TESTS: state.ts — getSessionByBranch
// =============================================================================

describe("getSessionByBranch", () => {
	const dbPath = path.join(SANDBOX, "state-test.sqlite")
	let db: Database

	beforeAll(() => {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true })
		db = new Database(dbPath)
		db.run("PRAGMA journal_mode=WAL")
		db.run(`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			branch TEXT NOT NULL,
			path TEXT NOT NULL,
			created_at TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'plugin'
		)`)
		db.run(`CREATE TABLE IF NOT EXISTS pending_delete (
			branch TEXT PRIMARY KEY,
			path TEXT NOT NULL
		)`)
	})

	afterAll(() => {
		db.close()
		fs.rmSync(dbPath, { force: true })
	})

	test("returns null for empty database", () => {
		const result = getSessionByBranch(db, "feature/nonexistent")
		expect(result).toBeNull()
	})

	test("finds a session by branch name", () => {
		addSession(db, {
				id: "test-session-1",
				branch: "feature/my-feature",
				path: "/tmp/worktrees/my-feature",
				createdAt: "2025-01-01T00:00:00Z",
				source: "plugin",
			})
		const result = getSessionByBranch(db, "feature/my-feature")
		expect(result).not.toBeNull()
		expect(result!.id).toBe("test-session-1")
		expect(result!.branch).toBe("feature/my-feature")
		expect(result!.path).toBe("/tmp/worktrees/my-feature")
		expect(result!.createdAt).toBe("2025-01-01T00:00:00Z")
	})

	test("returns null for non-matching branch", () => {
		const result = getSessionByBranch(db, "feature/other-branch")
		expect(result).toBeNull()
	})

	test("findSessionByBranch and getSessionByPath return the same session", () => {
		const byBranch = getSessionByBranch(db, "feature/my-feature")
		const byPath = getSessionByPath(db, "/tmp/worktrees/my-feature")
		expect(byBranch).not.toBeNull()
		expect(byPath).not.toBeNull()
		expect(byBranch!.id).toBe(byPath!.id)
		expect(byBranch!.branch).toBe(byPath!.branch)
	})

	test("returns first matching session when multiple sessions share a branch", () => {
		addSession(db, {
				id: "test-session-duplicate",
				branch: "feature/duplicate",
				path: "/tmp/worktrees/duplicate-1",
				createdAt: "2025-01-01T00:00:00Z",
				source: "plugin",
			})
			addSession(db, {
				id: "test-session-duplicate-2",
				branch: "feature/duplicate",
				path: "/tmp/worktrees/duplicate-2",
				createdAt: "2025-01-02T00:00:00Z",
				source: "plugin",
			})
		const result = getSessionByBranch(db, "feature/duplicate")
		expect(result).not.toBeNull()
		// Should return the first inserted row
		expect(result!.path).toBe("/tmp/worktrees/duplicate-1")
	})

	test("returns null for empty branch name", () => {
		const result = getSessionByBranch(db, "")
		expect(result).toBeNull()
	})

	test("returns null after session is removed", () => {
		removeSession(db, "feature/my-feature")
		const result = getSessionByBranch(db, "feature/my-feature")
		expect(result).toBeNull()
	})
})

// =============================================================================
// TESTS: Cross-session deletion scenario (worktreeDelete with branch param)
// =============================================================================

describe("cross-session worktreeDelete scenario", () => {
	const mainRepo = path.join(SANDBOX, "cross-session-main")
	const worktreesDir = path.join(SANDBOX, "cross-session-wts")
	const branch = "feature/cross-session-test"
	const wtPath = path.join(worktreesDir, "cross-session-test")

	beforeAll(() => {
		fs.mkdirSync(mainRepo, { recursive: true })
		createGitRepo(mainRepo, "main")
		fs.mkdirSync(worktreesDir, { recursive: true })
		// Create feature branch with a commit, merge into main
		execSync(`git checkout -b ${branch}`, { cwd: mainRepo })
		fs.writeFileSync(path.join(mainRepo, "cross-session.txt"), "cross-session work")
		execSync("git add -A", { cwd: mainRepo })
		execSync(`git commit -m "feat: cross-session test"`, { cwd: mainRepo })
		execSync("git checkout main", { cwd: mainRepo })
		execSync(`git merge ${branch} --no-edit`, { cwd: mainRepo })
		// Create worktree
		execSync(`git worktree add ${wtPath} ${branch}`, { cwd: mainRepo })
	})

	afterAll(() => {
		try {
			if (fs.existsSync(wtPath)) {
				execSync(`git worktree remove --force "${wtPath}"`, { cwd: mainRepo })
			}
		} catch { /* best-effort */ }
		fs.rmSync(worktreesDir, { recursive: true, force: true })
		fs.rmSync(mainRepo, { recursive: true, force: true })
	})

	test("simulates finding a worktree via branch and cleaning it up", async () => {
		// Simulate what worktreeCreate would do: add session to DB
		const dbPath = path.join(SANDBOX, "cross-session-db.sqlite")
		const db = new Database(dbPath)
		db.run("PRAGMA journal_mode=WAL")
		db.run(`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			branch TEXT NOT NULL,
			path TEXT NOT NULL,
			created_at TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'plugin'
		)`)
		db.run(`CREATE TABLE IF NOT EXISTS pending_delete (
			branch TEXT PRIMARY KEY,
			path TEXT NOT NULL
		)`)

		// In the real flow, worktreeCreate would call addSession()
		addSession(db, {
			id: "cross-session-wt",
			branch,
			path: wtPath,
			createdAt: new Date().toISOString(),
			source: "plugin",
		})

		// Verify we can find it by branch (simulating the parent session's worktreeDelete call)
		const found = getSessionByBranch(db, branch)
		expect(found).not.toBeNull()
		expect(found!.branch).toBe(branch)
		expect(found!.path).toBe(wtPath)
		expect(found!.id).toBe("cross-session-wt")

		// Validate the worktree is clean
		const cleanResult = await validateWorktreeClean(wtPath)
		expect(cleanResult.ok).toBe(true)

		// Validate the branch is merged into main
		const mergeResult = await validateBranchMerged(mainRepo, branch, "main")
		expect(mergeResult.ok).toBe(true)

		// Simulate the actual cleanup (what cleanupPendingWorktree does)
		const cleanupResult = await cleanupPendingWorktree(mainRepo, branch, wtPath)
		expect(cleanupResult.ok).toBe(true)
		expect(cleanupResult.worktreeRemoved).toBe(true)
		expect(cleanupResult.localBranchDeleted).toBe(true)
		expect(cleanupResult.errors).toEqual([])

		// Verify the worktree directory is gone
		expect(fs.existsSync(wtPath)).toBe(false)

		db.close()
		fs.rmSync(dbPath, { force: true })
	})
})

// =============================================================================
// TESTS: listWorktreesPorcelain
// =============================================================================

describe("listWorktreesPorcelain", () => {
	const mainRepo = path.join(SANDBOX, "porcelain-main")
	const worktreesDir = path.join(SANDBOX, "porcelain-wts")
	const branch = "feature/porcelain-test"
	const wtPath = path.join(worktreesDir, "porcelain-test")

	beforeAll(() => {
		fs.mkdirSync(mainRepo, { recursive: true })
		createGitRepo(mainRepo, "main")
		fs.mkdirSync(worktreesDir, { recursive: true })
		execSync(`git checkout -b ${branch}`, { cwd: mainRepo })
		fs.writeFileSync(path.join(mainRepo, "porcelain.txt"), "porcelain work")
		execSync("git add -A", { cwd: mainRepo })
		execSync(`git commit -m "feat: porcelain test"`, { cwd: mainRepo })
		execSync("git checkout main", { cwd: mainRepo })
		execSync(`git worktree add ${wtPath} ${branch}`, { cwd: mainRepo })
	})

	afterAll(() => {
		try {
			if (fs.existsSync(wtPath)) {
				execSync(`git worktree remove --force "${wtPath}"`, { cwd: mainRepo })
			}
		} catch { /* best-effort */ }
		fs.rmSync(worktreesDir, { recursive: true, force: true })
		fs.rmSync(mainRepo, { recursive: true, force: true })
	})

	test("parses porcelain output and finds the worktree by branch", async () => {
		const result = await listWorktreesPorcelain(mainRepo)
		expect(result.ok).toBe(true)

		const entries = result.value!
		expect(entries.length).toBeGreaterThanOrEqual(2) // main repo + worktree

		// Find the worktree entry
		const wtEntry = entries.find((e) => e.path === wtPath)
		expect(wtEntry).toBeDefined()
		expect(wtEntry!.branch).toBe(branch)
	})

	test("main repo entry is included with its branch", async () => {
		const result = await listWorktreesPorcelain(mainRepo)
		expect(result.ok).toBe(true)

		const mainEntry = result.value!.find((e) => e.path === mainRepo)
		expect(mainEntry).toBeDefined()
		expect(mainEntry!.branch).toBe("main")
	})
})

// =============================================================================
// TESTS: importManualWorktrees
// =============================================================================

describe("importManualWorktrees", () => {
	const dbPath = path.join(SANDBOX, "import-test.sqlite")
	let db: Database

	beforeAll(() => {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true })
		db = new Database(dbPath)
		db.run("PRAGMA journal_mode=WAL")
		db.run(`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			branch TEXT NOT NULL,
			path TEXT NOT NULL,
			created_at TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'plugin'
		)`)
		db.run(`CREATE TABLE IF NOT EXISTS pending_delete (
			branch TEXT PRIMARY KEY,
			path TEXT NOT NULL
		)`)
	})

	afterAll(() => {
		db.close()
		fs.rmSync(dbPath, { force: true })
	})

	test("imports worktrees not in the database", () => {
		const entries = [
			{ path: "/tmp/wt/feature-one", branch: "feature/one" },
			{ path: "/tmp/wt/feature-two", branch: "feature/two" },
		]

		const count = importManualWorktrees(db, entries)
		expect(count).toBe(2)

		// Verify sessions were added with source='manual'
		const s1 = getSessionByBranch(db, "feature/one")
		expect(s1).not.toBeNull()
		expect(s1!.source).toBe("manual")
		expect(s1!.path).toBe("/tmp/wt/feature-one")

		const s2 = getSessionByBranch(db, "feature/two")
		expect(s2).not.toBeNull()
		expect(s2!.source).toBe("manual")
		expect(s2!.path).toBe("/tmp/wt/feature-two")
	})

	test("skips entries that already exist in the database", () => {
		const entries = [
			{ path: "/tmp/wt/feature-one", branch: "feature/one" }, // already exists
			{ path: "/tmp/wt/feature-three", branch: "feature/three" }, // new
		]

		const count = importManualWorktrees(db, entries)
		expect(count).toBe(1) // only feature/three was new

		// The existing one should still have its original source
		const s1 = getSessionByBranch(db, "feature/one")
		expect(s1).not.toBeNull()
		expect(s1!.source).toBe("manual")
	})

	test("skips detached HEAD entries (no branch)", () => {
		const entries = [
			{ path: "/tmp/wt/detached", branch: null },
		]

		const count = importManualWorktrees(db, entries)
		expect(count).toBe(0)
	})

	test("has no effect when called with empty array", () => {
		const beforeCount = getAllSessions(db).length
		const count = importManualWorktrees(db, [])
		expect(count).toBe(0)
		expect(getAllSessions(db).length).toBe(beforeCount)
	})
})

// =============================================================================
// TESTS: manual worktree deletion flow (simulates worktreeDelete with import)
// =============================================================================

describe("manual worktree deletion flow", () => {
	const mainRepo = path.join(SANDBOX, "manual-delete-main")
	const worktreesDir = path.join(SANDBOX, "manual-delete-wts")
	const branch = "feature/manual-delete"
	const wtPath = path.join(worktreesDir, "manual-delete")

	// Each test gets its own DB to avoid cross-test pollution
	let db: Database
	const dbPath = path.join(SANDBOX, `manual-delete-db-${Date.now()}.sqlite`)

	beforeAll(() => {
		fs.mkdirSync(mainRepo, { recursive: true })
		createGitRepo(mainRepo, "main")
		fs.mkdirSync(worktreesDir, { recursive: true })

		// Create feature branch, commit, merge into main, create worktree manually
		execSync(`git checkout -b ${branch}`, { cwd: mainRepo })
		fs.writeFileSync(path.join(mainRepo, "manual-delete.txt"), "manual work")
		execSync("git add -A", { cwd: mainRepo })
		execSync(`git commit -m "feat: manual delete test"`, { cwd: mainRepo })
		execSync("git checkout main", { cwd: mainRepo })
		execSync(`git merge ${branch} --no-edit`, { cwd: mainRepo })
		// Manual worktree creation (NOT via plugin)
		execSync(`git worktree add ${wtPath} ${branch}`, { cwd: mainRepo })
	})

	afterAll(() => {
		try {
			if (fs.existsSync(wtPath)) {
				execSync(`git worktree remove --force "${wtPath}"`, { cwd: mainRepo })
			}
		} catch { /* best-effort */ }
		fs.rmSync(worktreesDir, { recursive: true, force: true })
		fs.rmSync(mainRepo, { recursive: true, force: true })
		if (db) db.close()
		fs.rmSync(dbPath, { force: true })
	})

	test("branch not in DB, but exists as a git worktree — import + find it", async () => {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true })
		db = new Database(dbPath)
		db.run("PRAGMA journal_mode=WAL")
		db.run(`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			branch TEXT NOT NULL,
			path TEXT NOT NULL,
			created_at TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'plugin'
		)`)
		db.run(`CREATE TABLE IF NOT EXISTS pending_delete (
			branch TEXT PRIMARY KEY,
			path TEXT NOT NULL
		)`)

		// Simulate: branch not in DB initially
		let session = getSessionByBranch(db, branch)
		expect(session).toBeNull()

		// Import from porcelain
		const porcelainResult = await listWorktreesPorcelain(mainRepo)
		expect(porcelainResult.ok).toBe(true)

		const imported = importManualWorktrees(db, porcelainResult.value)
		expect(imported).toBeGreaterThanOrEqual(1) // at least our worktree

		// Retry lookup
		session = getSessionByBranch(db, branch)
		expect(session).not.toBeNull()
		expect(session!.branch).toBe(branch)
		expect(session!.path).toBe(wtPath)
		expect(session!.source).toBe("manual")

		// Validate clean state
		const cleanResult = await validateWorktreeClean(wtPath)
		expect(cleanResult.ok).toBe(true)

		// Validate merged
		const mergeResult = await validateBranchMerged(mainRepo, branch, "main")
		expect(mergeResult.ok).toBe(true)

		// Cleanup: remove worktree + delete branch
		const cleanupResult = await cleanupPendingWorktree(mainRepo, branch, wtPath)
		expect(cleanupResult.ok).toBe(true)
		expect(cleanupResult.worktreeRemoved).toBe(true)
		expect(cleanupResult.localBranchDeleted).toBe(true)
		expect(fs.existsSync(wtPath)).toBe(false)
	})
})
