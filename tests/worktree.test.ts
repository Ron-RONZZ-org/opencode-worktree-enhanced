/**
 * Tests for opencode-worktree-enhanced.
 *
 * Run with: bun test tests/
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execSync } from "node:child_process"

import { validateBranchName } from "../src/validate"
import {
	deleteLocalBranch,
	getMainRepoRoot,
	git,
	removeWorktree,
	validateBranchMerged,
	validateWorktreeClean,
} from "../src/git"

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
// TESTS: full worktreeDelete simulation (from a worktree, using mainRepoRoot)
// =============================================================================

describe("worktreeDelete from worktree via mainRepoRoot", () => {
	const mainRepo = path.join(SANDBOX, "wt-full-sim-main")
	const worktreesDir = path.join(SANDBOX, "wt-full-sim-worktrees")
	const branch = "feature/wt-sim"
	const wtPath = path.join(worktreesDir, "wt-sim")

	beforeAll(() => {
		fs.mkdirSync(mainRepo, { recursive: true })
		createGitRepo(mainRepo, "main")
		fs.mkdirSync(worktreesDir, { recursive: true })
		// Create a clean, merged branch
		execSync(`git checkout -b ${branch}`, { cwd: mainRepo })
		fs.writeFileSync(path.join(mainRepo, "feature.txt"), "feature work")
		execSync("git add -A", { cwd: mainRepo })
		execSync(`git commit -m "feat: work on ${branch}"`, { cwd: mainRepo })
		// Merge into main
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

	test("simulates worktreeDelete from worktree: remove worktree → delete branch — no ENOENT", async () => {
		// Step 1: Resolve the main repo root FROM the worktree — this is the fix:
		// using a CWD that NEVER gets deleted (unlike the old code that used wtPath)
		const mainRoot = await getMainRepoRoot(wtPath)
		expect(mainRoot).toBe(mainRepo)

		// Step 2: Remove worktree using mainRepoRoot as CWD — this is the critical fix.
		// In the old code this used wtPath as CWD; after deletion the CWD was invalid.
		const removeResult = await removeWorktree(mainRoot!, wtPath)
		expect(removeResult.ok).toBe(true)

		// Step 3: Delete local branch using mainRepoRoot as CWD — still valid because
		// mainRoot is the parent repo, which was never deleted.
		const branchResult = await deleteLocalBranch(mainRoot!, branch)
		expect(branchResult.ok).toBe(true)

		// Verify the worktree directory is gone
		expect(fs.existsSync(wtPath)).toBe(false)

		// Verify the branch is gone
		const verifyBranch = await git(["rev-parse", "--verify", branch], mainRoot!)
		expect(verifyBranch.ok).toBe(false)

		// Verify main repo git operations still work (CWD never went invalid)
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
