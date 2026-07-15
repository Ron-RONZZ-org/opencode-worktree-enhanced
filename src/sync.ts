/**
 * File sync utilities for opencode-worktree-enhanced.
 * Copies files and symlinks directories from the main worktree to a new worktree.
 */
import * as path from "node:path"
import { access, lstat, mkdir, realpath, rm, stat, symlink } from "node:fs/promises"
import type { Logger } from "./utils"

// =============================================================================
// PATH SAFETY
// =============================================================================

/** Validate that a path is safe (no escape from base directory). */
function isPathSafe(filePath: string, baseDir: string, log: Logger): boolean {
	if (path.isAbsolute(filePath)) {
		log.warn(`Rejected absolute path: ${filePath}`)
		return false
	}
	if (filePath.includes("..")) {
		log.warn(`Rejected path traversal: ${filePath}`)
		return false
	}
	const resolved = path.resolve(baseDir, filePath)
	if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
		log.warn(`Path escapes base directory: ${filePath}`)
		return false
	}
	return true
}

function isWithinRealRoot(rootRealPath: string, candidateRealPath: string): boolean {
	const relative = path.relative(rootRealPath, candidateRealPath)
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
}

async function resolveExistingPathWithinRoot(
	rootDir: string,
	relativePath: string,
	log: Logger,
): Promise<string | null> {
	const rootRealPath = await realpath(rootDir).catch(() => null)
	if (!rootRealPath) {
		log.warn(`Failed to resolve worktree root: ${rootDir}`)
		return null
	}
	const candidatePath = path.resolve(rootDir, relativePath)
	const candidateRealPath = await realpath(candidatePath).catch(() => null)
	if (!candidateRealPath) return null
	if (!isWithinRealRoot(rootRealPath, candidateRealPath)) {
		log.warn(`Rejected path escaping worktree via symlink: ${relativePath}`)
		return null
	}
	return candidateRealPath
}

async function ensureDirectoryWithinRoot(
	rootDir: string,
	relativeDir: string,
	log: Logger,
): Promise<string | null> {
	const rootRealPath = await realpath(rootDir).catch(() => null)
	if (!rootRealPath) {
		log.warn(`Failed to resolve worktree root: ${rootDir}`)
		return null
	}

	const rootPath = path.resolve(rootDir)
	const targetDir = path.resolve(rootDir, relativeDir)
	const resolvedRootRelative = path.relative(rootPath, targetDir)
	if (resolvedRootRelative !== "" &&
		(resolvedRootRelative.startsWith("..") || path.isAbsolute(resolvedRootRelative))) {
		log.warn(`Rejected path escaping worktree: ${relativeDir}`)
		return null
	}

	const rootRelative = path.relative(rootDir, targetDir)
	const parts = rootRelative.split(path.sep).filter(Boolean)
	let cursor = rootDir

	for (const part of parts) {
		cursor = path.join(cursor, part)
		const entry = await lstat(cursor).catch(() => null)
		if (entry?.isSymbolicLink()) {
			log.warn(`Rejected symlinked target parent: ${relativeDir}`)
			return null
		}
		if (entry && !entry.isDirectory()) {
			log.warn(`Rejected non-directory target parent: ${relativeDir}`)
			return null
		}
		if (!entry) {
			await mkdir(cursor)
		}
	}

	const finalRealPath = await realpath(targetDir).catch(() => null)
	if (!finalRealPath || !isWithinRealRoot(rootRealPath, finalRealPath)) {
		log.warn(`Rejected path escaping worktree via symlink: ${relativeDir}`)
		return null
	}
	return targetDir
}

// =============================================================================
// FILE OPERATIONS
// =============================================================================

/**
 * Copy files from source directory to target directory.
 * Skips missing files silently.
 */
export async function copyFiles(
	sourceDir: string,
	targetDir: string,
	files: string[],
	log: Logger,
): Promise<void> {
	for (const file of files) {
		if (!isPathSafe(file, sourceDir, log)) continue

		const sourcePath = await resolveExistingPathWithinRoot(sourceDir, file, log)
		if (!sourcePath) continue

		const targetPath = path.join(targetDir, file)

		try {
			const sourceFile = Bun.file(sourcePath)
			if (!(await sourceFile.exists())) {
				log.debug(`Skipping missing file: ${file}`)
				continue
			}

			// Ensure target directory exists
			const targetFileDir = path.dirname(targetPath)
			const targetFileRelativeDir = path.relative(targetDir, targetFileDir)
			if (!(await ensureDirectoryWithinRoot(targetDir, targetFileRelativeDir, log))) continue

			const existingTarget = await lstat(targetPath).catch(() => null)
			if (existingTarget?.isSymbolicLink()) {
				log.warn(`Rejected symlinked target file: ${file}`)
				continue
			}

			await Bun.write(targetPath, sourceFile)
			log.info(`Copied: ${file}`)
		} catch (error) {
			const isNotFound =
				error instanceof Error &&
				(error.message.includes("ENOENT") || error.message.includes("no such file"))
			if (isNotFound) {
				log.debug(`Skipping missing: ${file}`)
			} else {
				log.warn(`Failed to copy ${file}: ${error}`)
			}
		}
	}
}

/**
 * Create symlinks for directories from source to target.
 * Uses absolute paths for symlink targets.
 */
export async function symlinkDirs(
	sourceDir: string,
	targetDir: string,
	dirs: string[],
	log: Logger,
): Promise<void> {
	for (const dir of dirs) {
		if (!isPathSafe(dir, sourceDir, log)) continue

		const sourcePath = await resolveExistingPathWithinRoot(sourceDir, dir, log)
		if (!sourcePath) continue

		const targetPath = path.join(targetDir, dir)

		try {
			const fileStat = await stat(sourcePath).catch(() => null)
			if (!fileStat?.isDirectory()) {
				log.debug(`Skipping missing directory: ${dir}`)
				continue
			}

			const targetParentDir = path.dirname(targetPath)
			const targetParentRelativeDir = path.relative(targetDir, targetParentDir)
			if (!(await ensureDirectoryWithinRoot(targetDir, targetParentRelativeDir, log))) continue

			const existingTarget = await lstat(targetPath).catch(() => null)
			if (existingTarget?.isSymbolicLink()) {
				log.warn(`Rejected symlinked target: ${dir}`)
				continue
			}

			await rm(targetPath, { recursive: true, force: true })
			await symlink(sourcePath, targetPath, "dir")
			log.info(`Symlinked: ${dir}`)
		} catch (error) {
			log.warn(`Failed to symlink ${dir}: ${error}`)
		}
	}
}

// =============================================================================
// HOOKS
// =============================================================================

/**
 * Run hook commands in the worktree directory.
 */
export async function runHooks(
	cwd: string,
	commands: string[],
	log: Logger,
): Promise<void> {
	for (const command of commands) {
		log.info(`Running hook: ${command}`)
		try {
			const result = Bun.spawnSync(["bash", "-c", command], {
				cwd,
				stdout: "inherit",
				stderr: "pipe",
			})
			if (result.exitCode !== 0) {
				const stderr = result.stderr?.toString() || ""
				log.warn(
					`Hook failed (exit ${result.exitCode}): ${command}${stderr ? `\n${stderr}` : ""}`,
				)
			}
		} catch (error) {
			log.warn(`Hook error: ${error}`)
		}
	}
}
