/**
 * opencode-worktree-enhanced — standalone opencode worktree plugin.
 *
 * Tools:
 *   worktreeCreate — Create a git worktree + spawn a new OpenCode terminal (delegation)
 *   worktreeNew    — Create a git worktree without a terminal (current agent works directly)
 *   worktreeDelete — Validate and mark a worktree for deferred cleanup
 *   worktreeList   — List all worktrees with auto-import of manual ones
 */
import { type Plugin, tool } from "@opencode-ai/plugin"

import { loadWorktreeConfig } from "./config"
import {
	cleanupPendingWorktree,
	createWorktree,
	getMainRepoRoot,
	getWorktreePath,
	listWorktrees,
	listWorktreesPorcelain,
	validateBranchMerged,
	validateWorktreeClean,
} from "./git"
import {
	addSession,
	clearPendingDelete,
	getAllSessions,
	getPendingDelete,
	getSession,
	getSessionByBranch,
	getSessionByPath,
	importManualWorktrees,
	initStateDb,
	removeSession,
	setPendingDelete,
} from "./state"
import { copyFiles, runHooks, symlinkDirs } from "./sync"
import { buildOpenCodeLaunchArgv, openTerminal } from "./terminal"
import { makeLogger } from "./utils"
import { validateBranchName } from "./validate"

const PLUGIN_MARKER = "opencode-worktree-enhanced"

const WORKTREE_TOOLS_GUIDANCE = `<WORKTREE_TOOLS_PLUGIN>
You have dedicated Git worktree tools. Prefer them over raw \`git worktree\` bash:

| Tool | Use when |
|------|----------|
| \`worktreeCreate\` | Create a worktree + spawn a new OpenCode terminal (for master agents delegating work). |
| \`worktreeNew\` | Create a worktree without a new terminal (for the current agent to work directly). Returns path + branch. |
| \`worktreeDelete\` | Mark a worktree for deferred cleanup. Validates clean state + merged branch, then defers actual deletion to next \`worktreeCreate\` call. **\`branch\` is REQUIRED.** Works for plugin-managed and manually-created worktrees. |
| \`worktreeList\` | List all worktrees (plugin-managed, manually-created, pending cleanup). Auto-imports manual worktrees. |

Workflow:
1. \`worktreeCreate\` (delegate) or \`worktreeNew\` (work directly) with a branch name
2. Work in the worktree directory
3. \`worktreeDelete\` with \`branch\` and a reason when done — validates clean state and merged branch, marks for deferred cleanup (directory stays until session ends, actual removal happens on next \`worktreeCreate\`)
4. The \`branch\` parameter is always required — use \`worktreeList\` first to discover active sessions if you don't know the branch name

**IMPORTANT**: Never use \`rm -rf\` on a worktree directory — this orphans the active opencode session and can cause data loss. Always use \`worktreeDelete\`.

Config: \`.opencode/worktree.jsonc\` (auto-created) controls sync, hooks, terminal mode (\`newTerminal\`), and session history (\`preserveHistory\`).
Storage: ~/.local/share/opencode/worktree/<project-name>/<branch>/
</WORKTREE_TOOLS_PLUGIN>`

type Database = import("bun:sqlite").Database

let db: Database | null = null
let projectRoot: string | null = null
let cleanupRegistered = false

function registerCleanupHandlers(database: Database): void {
	if (cleanupRegistered) return
	cleanupRegistered = true
	const cleanup = () => {
		try {
			database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
			database.close()
		} catch {
			/* best-effort */
		}
	}
	process.once("SIGTERM", cleanup)
	process.once("SIGINT", cleanup)
	process.once("beforeExit", cleanup)
}

async function isGitRepo($: { text: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Response> }, directory: string): Promise<boolean> {
	try {
		return (await $`git -C ${directory} rev-parse --is-inside-work-tree`.text()).trim() === "true"
	} catch {
		return false
	}
}

/**
 * Result of the shared worktree creation flow.
 */
interface CreateWorktreeResult {
	ok: true
	worktreePath: string
	branch: string
	config: import("./config").WorktreeConfig
}
type CreateWorktreeError = { ok: false; error: string }

/**
 * Shared worktree creation logic used by both worktreeCreate and worktreeNew.
 *
 * Handles: branch validation, config loading, pending cleanup, git worktree add,
 * session registration, file sync, and post-create hooks.
 *
 * Does NOT handle terminal spawning — that's the caller's responsibility.
 */
async function createWorktreeCommon(
	args: { branch: string; baseBranch?: string },
	context: {
		db: Database
		directory: string
		logger: import("./utils").Logger
	},
): Promise<CreateWorktreeResult | CreateWorktreeError> {
	const { db, directory, logger: log } = context
	const { branch, baseBranch } = args

	const branchError = validateBranchName(branch)
	if (branchError) return { ok: false, error: `❌ Invalid branch name: ${branchError}` }

	if (baseBranch) {
		const baseError = validateBranchName(baseBranch)
		if (baseError) return { ok: false, error: `❌ Invalid base branch name: ${baseError}` }
	}

	const config = await loadWorktreeConfig(directory, log)

	// Clean up any orphaned pending worktree deletions before creating a new one.
	// Uses the global DB, so this works from any session (parent or worktree).
	const mainRepoRoot = await getMainRepoRoot(directory)
	if (mainRepoRoot) {
		const pending = getPendingDelete(db)
		if (pending) {
			const existingSession = getSessionByPath(db, pending.path)
			if (!existingSession) {
				log.info(`Cleaning up pending worktree: ${pending.branch}`)
				const cleanupResult = await cleanupPendingWorktree(
					mainRepoRoot,
					pending.branch,
					pending.path,
					(msg) => log.info(msg),
				)
				if (cleanupResult.worktreeRemoved) {
					log.info(`  Removed worktree: ${pending.path}`)
				}
				if (cleanupResult.localBranchDeleted) {
					log.info(`  Deleted local branch: ${pending.branch}`)
				}
				if (cleanupResult.remoteBranchDeleted) {
					log.info(`  Deleted remote branch: ${pending.branch}`)
				}
				if (cleanupResult.errors.length) {
					for (const err of cleanupResult.errors) {
						log.warn(`  Cleanup warning: ${err}`)
					}
				}
				clearPendingDelete(db)
			} else {
				log.debug("Pending worktree still has active session — skipping cleanup")
			}
		}
	}

	const result = await createWorktree(directory, branch, baseBranch, config.worktreePath)
	if (!result.ok) return { ok: false, error: `❌ Failed to create worktree: ${result.error}` }

	const worktreePath = result.value

	// Register session IMMEDIATELY after worktree creation, before
	// any subsequent operations (sync, hooks). This ensures the session
	// is in the DB even if something fails later — preventing a worktree
	// from existing without a DB record.
	addSession(db, {
		id: `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		branch,
		path: worktreePath,
		createdAt: new Date().toISOString(),
		source: "plugin",
	})

	// Sync files from main worktree
	if (config.sync.copyFiles.length) {
		await copyFiles(directory, worktreePath, config.sync.copyFiles, log)
	}
	if (config.sync.symlinkDirs.length) {
		await symlinkDirs(directory, worktreePath, config.sync.symlinkDirs, log)
	}
	if (config.hooks.postCreate.length) {
		await runHooks(worktreePath, config.hooks.postCreate, log)
	}

	return { ok: true, worktreePath, branch, config }
}

export const WorktreeEnhancedPlugin: Plugin = async ({ client, directory, $ }) => {
	const inRepo = await isGitRepo($, directory)
	const log = makeLogger(client, PLUGIN_MARKER)

	projectRoot = directory
	if (inRepo) {
		// The state DB is stored globally (~/.local/share/opencode/plugins/worktree/)
		// keyed by a stable project ID that is the SAME from any worktree.
		// getProjectId() inside initStateDb handles worktree .git file resolution,
		// so ALL sessions (parent + children) share one DB automatically.
		db = await initStateDb(directory)
		registerCleanupHandlers(db)
		log.info("State DB initialized (global, keyed by project ID)")
	}

	await client.app.log({
		body: {
			service: PLUGIN_MARKER,
			level: "info",
			message: inRepo
				? "Worktree tools active"
				: "Worktree tools loaded (not in a git repo)",
		},
	})

	return {
		config: async (config) => {
			if (!inRepo) return
			config.instructions = config.instructions ?? []
			const hasMarker = config.instructions.some(
				(item) => typeof item === "string" && item.includes(PLUGIN_MARKER),
			)
			if (!hasMarker) {
				config.instructions.push(
					`${PLUGIN_MARKER}: tools: worktreeCreate, worktreeNew, worktreeDelete, worktreeList. ` +
					`\`worktreeNew\` = create w/out terminal (for current agent); ` +
					`\`worktreeCreate\` = create + spawn terminal (for delegation). ` +
					`\`worktreeDelete\` requires \`branch\` — handles both plugin and manual worktrees. ` +
					`Never use \`rm -rf\` on worktree directories — always use worktreeDelete.`,
				)
			}
		},

		"experimental.chat.messages.transform": async (_input, output) => {
			if (!inRepo || !output.messages.length) return
			const firstUser = output.messages.find((m) => m.info.role === "user")
			if (!firstUser?.parts.length) return
			if (firstUser.parts.some((p) => p.type === "text" && p.text.includes("<WORKTREE_TOOLS_PLUGIN>"))) return
			const ref = firstUser.parts[0]
			firstUser.parts.unshift({ ...ref, type: "text", text: WORKTREE_TOOLS_GUIDANCE })
		},

		"experimental.session.compacting": async (_input, output) => {
			if (!inRepo) return
			output.context.push(`
## Worktree Tools (${PLUGIN_MARKER})
Tools: worktreeCreate (delegate), worktreeNew (work directly), worktreeDelete, worktreeList.
\`worktreeDelete\` works for both plugin-managed and manually-created worktrees.
**\`worktreeDelete\` requires \`branch\`** — always specify which worktree to delete.
Use \`worktreeList\` to discover active sessions.
Never use raw \`git worktree add/remove\` when plugin tools are available.
**Never use \`rm -rf\` on a worktree directory** — always use worktreeDelete.
Config: .opencode/worktree.jsonc (\`newTerminal\`, \`preserveHistory\`, sync, hooks)
`)
		},

		tool: {
			worktreeCreate: tool({
				description:
					"Create an isolated git worktree and spawn a new terminal with OpenCode " +
					"(for master agents delegating work to a child agent). " +
					"Prefer \`worktreeNew\` when the current agent intends to work directly.",
				args: {
					branch: tool.schema.string().describe("Branch name, e.g. feature/dark-mode"),
					baseBranch: tool.schema
						.string()
						.optional()
						.describe("Base branch to create from (defaults to HEAD)"),
				},
				async execute(args) {
					if (!db || !inRepo) return "Not in a git repository."

					const common = await createWorktreeCommon(args, { db, directory, logger: log })
					if (!common.ok) return common.error

					const { worktreePath, branch } = common

					// Launch opencode directly in the worktree directory (fresh session)
					const launchArgv = buildOpenCodeLaunchArgv(worktreePath)
					const terminalResult = await openTerminal(worktreePath, launchArgv, branch)

					if (!terminalResult.success) {
						return [
							`⚠️  Worktree created at ${worktreePath} — session registered.`,
							`Terminal spawn failed: ${terminalResult.error ?? "unknown error"}`,
							"Run `opencode .` manually in the worktree directory.",
						].join("\n")
					}

					return [
						`✅ Worktree created at ${worktreePath}`,
						`Branch: ${branch}`,
						`Opened in ${terminalResult.method ?? "a new terminal"}.`,
					].join("\n")
				},
			}),

			worktreeNew: tool({
				description:
					"Create a new git worktree (no new terminal spawned). " +
					"Returns the worktree path and branch for the calling agent to work with directly. " +
					"Use when the current agent is asked to work directly on something. " +
					"For delegating work to a child agent, use \`worktreeCreate\` which spawns a new terminal.",
				args: {
					branch: tool.schema.string().describe("Branch name, e.g. feature/dark-mode"),
					baseBranch: tool.schema
						.string()
						.optional()
						.describe("Base branch to create from (defaults to HEAD)"),
				},
				async execute(args) {
					if (!db || !inRepo) return "Not in a git repository."

					const common = await createWorktreeCommon(args, { db, directory, logger: log })
					if (!common.ok) return common.error

					return [
						`✅ Worktree created at ${common.worktreePath}`,
						`Branch: ${common.branch}`,
						`To start working: cd ${common.worktreePath}`,
					].join("\n")
				},
			}),

			worktreeDelete: tool({
				description:
					"Mark a worktree for deferred cleanup. Validates clean state and merge status, " +
					"then marks the worktree for deletion. Actual cleanup (remove directory, delete branches) " +
					"happens on the next worktreeCreate call. This keeps the session directory alive " +
					"so all tools continue to work. " +
					"Works for both plugin-managed and manually-created worktrees. " +
					"`branch` is REQUIRED — always specify which worktree to delete. " +
					"Use `worktreeList` first to find active sessions if unsure. " +
					"Never use `rm -rf` on a worktree directory.",
				args: {
					reason: tool.schema
						.string()
						.describe("Brief explanation of why you are calling this tool"),
					branch: tool.schema
						.string()
						.describe(
							"Branch name to delete. Always required — there is no default. " +
							"Use `worktreeList` to find active worktree sessions if you don't know the branch name.",
						),
					force: tool.schema
						.boolean()
						.optional()
						.default(false)
						.describe(
							"Skip the merge-into-main validation and force deletion. Only use if you have " +
								"confirmed the branch is safe to delete (e.g., squash-merged on GitHub).",
						),
				},
				async execute(args) {
					if (!db || !inRepo) return "Not in a git repository."

					// Resolve the parent repo root — needed for porcelain lookup and validation.
					const mainRepoRoot = await getMainRepoRoot(directory)
					if (!mainRepoRoot) {
						return "❌ Could not determine the main repository root. Aborting."
					}

					// Session lookup is always by branch name — it is a required parameter.
					let session = getSessionByBranch(db, args.branch)

					// Not found in DB? Try importing manually-created worktrees from git,
					// then retry the lookup. This handles worktrees created via `git worktree add`.
					if (!session) {
						const porcelainResult = await listWorktreesPorcelain(mainRepoRoot)
						if (porcelainResult.ok) {
							const imported = importManualWorktrees(db, porcelainResult.value)
							if (imported > 0) {
								log.info(`Imported ${imported} manually-created worktree(s) — retrying lookup`)
							}
						}
						session = getSessionByBranch(db, args.branch)
					}

					if (!session) {
						return (
							`❌ Branch "${args.branch}" was not found in any worktree.\n\n` +
							`No worktree is currently checked out at this branch. ` +
							`Use \`worktreeList\` to see all active worktrees, then retry with the correct branch name.`
						)
					}

					// ----- Validation phase (no deletion) -----
					// 1. Worktree must have no uncommitted changes
					const cleanResult = await validateWorktreeClean(session.path)
					if (!cleanResult.ok) {
						return `❌ ${cleanResult.error}`
					}

					// 2. Branch must be fully merged into main (unless --force)
					if (!args.force) {
						const baseBranch = "main"
						const mergeResult = await validateBranchMerged(mainRepoRoot, session.branch, baseBranch)
						if (!mergeResult.ok) {
							return (
								`❌ ${mergeResult.error}` +
								`\n\nIf you have confirmed this branch is safe to delete (e.g., it was ` +
								`squash-merged on GitHub), re-run with --force to skip this check.`
							)
						}
					}

					// ----- Mark pending (no disk operations) -----
					setPendingDelete(db, { branch: session.branch, path: session.path })
					removeSession(db, session.branch)

					return [
						`✅ Worktree "${session.branch}" marked for cleanup.`,
						`  - Directory: ${session.path}`,
						`  - All tools continue to work in this session.`,
						`  - Cleanup will run on the next \`worktreeCreate\` call.`,
					].join("\n")
				},
			}),

			worktreeList: tool({
				description:
					"List all git worktrees (plugin-managed, manually-created, and pending cleanup). " +
					"Auto-imports manually-created worktrees for tracking. " +
					"Prefer over bash git worktree list",
				args: {
					includeGit: tool.schema
						.boolean()
						.optional()
						.default(true)
						.describe("Include raw output from git worktree list"),
				},
				async execute(args) {
					if (!db || !inRepo) return "Not in a git repository."

					// Auto-import manually-created worktrees from git
					const mainRepoRoot = await getMainRepoRoot(directory)
					if (mainRepoRoot) {
						const porcelainResult = await listWorktreesPorcelain(mainRepoRoot)
						if (porcelainResult.ok) {
							const imported = importManualWorktrees(db, porcelainResult.value)
							if (imported > 0) {
								log.info(`Imported ${imported} manually-created worktree(s)`)
							}
						}
					}

					const sessions = getAllSessions(db)
					const lines: string[] = ["## Worktree sessions"]

					if (!sessions.length) {
						lines.push("(none)")
					} else {
						// Separate by source
						const pluginSessions = sessions.filter((s) => s.source === "plugin")
						const manualSessions = sessions.filter((s) => s.source === "manual")

						const formatSession = (s: { branch: string; path: string; createdAt: string; id: string }) =>
							`- ${s.branch} → ${s.path} (created ${s.createdAt})`

						if (pluginSessions.length) {
							lines.push("", `### Plugin-managed (${pluginSessions.length})`)
							for (const s of pluginSessions) lines.push(formatSession(s))
						}
						if (manualSessions.length) {
							lines.push("", `### Manually-created (${manualSessions.length})`)
							for (const s of manualSessions) lines.push(formatSession(s))
						}
					}

					// Show pending deletions — worktrees marked for cleanup but not yet removed.
					const pending = getPendingDelete(db)
					if (pending) {
						lines.push("", "## Pending cleanup", `- ${pending.branch} → ${pending.path} (deletion deferred)`)
					}

					if (args.includeGit) {
						lines.push("", "## Git worktrees (raw)")
						lines.push(await listWorktrees(directory))
					}

					const config = await loadWorktreeConfig(directory, log)
					const examplePath = await getWorktreePath(directory, "<branch>", config.worktreePath)
					lines.push("", `Default storage pattern: ${examplePath.replace("<branch>", "{branch}")}`)

					return lines.join("\n")
				},
			}),
		},

	}
}

export default WorktreeEnhancedPlugin
