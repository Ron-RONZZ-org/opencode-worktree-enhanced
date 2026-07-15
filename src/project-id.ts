/**
 * Stable project identifier for opencode-worktree-enhanced.
 *
 * Produces a deterministic, collision-resistant project ID that is the SAME
 * regardless of whether the plugin runs from the main checkout or a git
 * worktree. This is the foundation for sharing plugin state (worktree
 * sessions, pending operations) across all sessions of the same repo.
 *
 * Resolution order:
 *   1. Resolve the real git directory (handles worktree .git files)
 *   2. Check `.git/opencode` cache file for a previously-computed ID
 *   3. Compute root commit SHA via `git rev-list --max-parents=0 --all`
 *   4. Fall back to SHA-256 hash of the absolute project root path
 *
 * Ported from github.com/stevenke1981/opencode-worktree-tools.
 */
import * as crypto from "node:crypto"
import { stat } from "node:fs/promises"
import * as path from "node:path"

/**
 * Hash an absolute path into a 16-character hex string.
 * Used as a fallback when git history is unavailable.
 */
function hashPath(projectRoot: string): string {
	return crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 16)
}

/**
 * Resolve the real shared git directory from a project root.
 *
 * In a normal repo this is `<root>/.git`.
 * In a worktree, `.git` is a file containing `gitdir: <main>/.git/worktrees/<name>`.
 * This function follows the chain and resolves to the shared `.git` directory
 * (the `commondir` in a worktree's admin dir), so all worktrees of the same
 * repo produce the same project ID.
 *
 * When the project root is a subdirectory of the repo (without its own `.git`
 * entry), falls back to `git rev-parse --git-dir` to locate the actual git dir.
 */
async function resolveGitDir(projectRoot: string): Promise<string | null> {
	const gitPath = path.join(projectRoot, ".git")
	const gitStat = await stat(gitPath).catch(() => null)

	let gitDir: string
	let isWorktreePath = false

	if (gitStat) {
		gitDir = gitPath
		if (gitStat.isFile()) {
			// Worktree: .git is a file pointing to the real git dir
			isWorktreePath = true
			const content = await Bun.file(gitPath).text()
			const match = content.match(/^gitdir:\s*(.+)$/m)
			if (!match) return null
			gitDir = path.resolve(projectRoot, match[1].trim())
		}
	} else {
		// No .git in projectRoot — try git rev-parse to find it.
		// This handles the case where opencode runs from a subdirectory
		// of the repo (e.g. opencode-config/ inside basculer/).
		try {
			const proc = Bun.spawn(["git", "rev-parse", "--git-dir"], {
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			})
			const exitCode = await proc.exited
			if (exitCode !== 0) return null
			const revParseDir = (await new Response(proc.stdout).text()).trim()
			if (!revParseDir) return null
			gitDir = path.resolve(projectRoot, revParseDir)
			if (gitDir.includes("/worktrees/")) {
				isWorktreePath = true
			}
		} catch {
			return null
		}
	}

	// Resolve worktree admin dir to shared git directory via commondir
	if (isWorktreePath) {
		const commondirPath = path.join(gitDir, "commondir")
		const commondirFile = Bun.file(commondirPath)
		if (await commondirFile.exists()) {
			return path.resolve(gitDir, (await commondirFile.text()).trim())
		}
		// Without commondir, walk up from .git/worktrees/<name> → <main>/.git
		return path.resolve(gitDir, "../..")
	}

	return gitDir
}

/**
 * Get a stable, deterministic project ID for the given project root.
 *
 * The ID is the same from any worktree of the same repo, enabling shared
 * plugin state (e.g. session tracking, pending operations) across all
 * opencode sessions working on the same project.
 */
export async function getProjectId(projectRoot: string): Promise<string> {
	if (!projectRoot) throw new Error("projectRoot is required")

	const gitDir = await resolveGitDir(projectRoot)
	if (!gitDir) return hashPath(projectRoot)

	// Check for cached project ID in .git/opencode
	const cacheFile = path.join(gitDir, "opencode")
	const cache = Bun.file(cacheFile)
	if (await cache.exists()) {
		const cached = (await cache.text()).trim()
		if (/^[a-f0-9]{40}$/i.test(cached) || /^[a-f0-9]{16}$/i.test(cached)) {
			return cached
		}
	}

	// Compute root commit SHA as stable project identifier
	try {
		const proc = Bun.spawn(["git", "rev-list", "--max-parents=0", "--all"], {
			cwd: projectRoot,
			stdout: "pipe",
			stderr: "pipe",
		})
		const exitCode = await proc.exited
		if (exitCode === 0) {
			const roots = (await new Response(proc.stdout).text())
				.split("\n")
				.map((x) => x.trim())
				.filter(Boolean)
				.sort()
			if (roots[0] && /^[a-f0-9]{40}$/i.test(roots[0])) {
				// Cache for future lookups (best-effort)
				try {
					await Bun.write(cacheFile, roots[0])
				} catch {
					/* cache write is best-effort */
				}
				return roots[0]
			}
		}
	} catch {
		// fall through to path hash
	}

	// Final fallback: hash of the absolute path
	return hashPath(projectRoot)
}
