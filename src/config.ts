/**
 * Configuration loading for opencode-worktree-enhanced.
 * Reads `.opencode/worktree.jsonc` with auto-creation of default config.
 */
import * as path from "node:path"
import * as os from "node:os"
import { mkdir } from "node:fs/promises"
import { parse as parseJsonc } from "jsonc-parser"
import type { Logger } from "./utils"

/** Worktree plugin configuration */
export interface WorktreeConfig {
	/** Custom base path for worktree storage. Supports ~ for home directory. */
	worktreePath?: string
	sync: {
		/** Files to copy from main worktree (relative paths only) */
		copyFiles: string[]
		/** Directories to symlink from main worktree (saves disk space) */
		symlinkDirs: string[]
		/** Patterns to exclude from copying */
		exclude: string[]
	}
	hooks: {
		/** Commands to run after worktree creation */
		postCreate: string[]
		/** Commands to run before worktree deletion */
		preDelete: string[]
	}
	/** Spawn worktree in a new terminal window vs current tab */
	newTerminal: boolean
}

const DEFAULT_CONFIG: WorktreeConfig = {
	sync: { copyFiles: [], symlinkDirs: [], exclude: [] },
	hooks: { postCreate: [], preDelete: [] },
	newTerminal: true,
}

/**
 * Resolve a path that may contain a leading `~` to the user's home directory.
 */
function resolveHomePath(p: string): string {
	if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
		return path.join(os.homedir(), p.slice(1))
	}
	return p
}

/**
 * Default config file content with helpful comments.
 */
function defaultConfigFile(): string {
	return `{
  "$schema": "https://raw.githubusercontent.com/Ron-RONZZ-org/opencode-worktree-enhanced/main/schema.json",

  // Custom base path for worktree storage (supports ~)
  // Default: ~/.local/share/opencode/worktree
  // "worktreePath": "~/my-worktrees",

  "sync": {
    // Files to copy from main worktree to new worktrees
    // Example: [".env", ".env.local", "dev.sqlite"]
    "copyFiles": [],

    // Directories to symlink (saves disk space)
    // Example: ["node_modules"]
    "symlinkDirs": [],

    // Patterns to exclude from copying
    "exclude": []
  },

  "hooks": {
    // Commands to run after worktree creation
    // Example: ["pnpm install", "docker compose up -d"]
    "postCreate": [],

    // Commands to run before worktree deletion
    // Example: ["docker compose down"]
    "preDelete": []
  },

  // Spawn worktree in a new terminal window (true) or current tab (false)
  "newTerminal": true
}
`
}

/**
 * Load worktree configuration from `.opencode/worktree.jsonc`.
 * Auto-creates config file with helpful defaults if it doesn't exist.
 */
export async function loadWorktreeConfig(
	directory: string,
	log: Logger,
): Promise<WorktreeConfig> {
	const configPath = path.join(directory, ".opencode", "worktree.jsonc")

	try {
		const file = Bun.file(configPath)
		if (!(await file.exists())) {
			// Auto-create config with defaults
			const configDir = path.join(directory, ".opencode")
			await mkdir(configDir, { recursive: true })
			await Bun.write(configPath, defaultConfigFile())
			log.info(`Created default config: ${configPath}`)
			return { ...DEFAULT_CONFIG }
		}

		const content = await file.text()
		const parsed = parseJsonc(content)
		if (parsed === undefined) {
			log.warn("Invalid worktree.jsonc syntax, using defaults")
			return { ...DEFAULT_CONFIG }
		}

		// Merge parsed config with defaults
		const config: WorktreeConfig = {
			sync: {
				copyFiles: arrayOr(parsed?.sync?.copyFiles, []),
				symlinkDirs: arrayOr(parsed?.sync?.symlinkDirs, []),
				exclude: arrayOr(parsed?.sync?.exclude, []),
			},
			hooks: {
				postCreate: arrayOr(parsed?.hooks?.postCreate, []),
				preDelete: arrayOr(parsed?.hooks?.preDelete, []),
			},
			newTerminal: parsed?.newTerminal !== false,
		}
		if (parsed?.worktreePath) {
			config.worktreePath = resolveHomePath(String(parsed.worktreePath))
		}
		return config
	} catch (error) {
		log.warn(`Failed to load config: ${error}`)
		return { ...DEFAULT_CONFIG }
	}
}

/** Helper to safely extract an array from parsed JSON. */
function arrayOr(val: unknown, fallback: string[]): string[] {
	if (Array.isArray(val)) return val.map(String)
	return fallback
}
