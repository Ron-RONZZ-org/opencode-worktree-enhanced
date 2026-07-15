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
import { git, validateWorktreeClean, validateBranchMerged, removeWorktree } from "../src/git"

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
