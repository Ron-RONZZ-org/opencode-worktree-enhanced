/**
 * opencode-worktree-enhanced — standalone opencode worktree plugin.
 *
 * Tools:
 *   worktreeCreate — Create an isolated git worktree + open a new terminal
 *   worktreeDelete — Validate and delete the current worktree (clean + merged checks)
 *   worktreeList   — List plugin-managed sessions and git worktrees
 */
import { type Plugin, tool } from "@opencode-ai/plugin"

import { loadWorktreeConfig } from "./config"
import {
	createWorktree,
	deleteLocalBranch,
	deleteRemoteBranch,
	getWorktreePath,
	git,
	listWorktrees,
	removeWorktree,
	validateBranchMerged,
	validateWorktreeClean,
} from "./git"
import {
	addSession,
	clearPendingDelete,
	getAllSessions,
	getPendingDelete,
	getSession,
	getSessionByPath,
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
| \`worktreeCreate\` | Create an isolated worktree + spawn OpenCode in a new terminal |
| \`worktreeDelete\` | Validate and delete the current worktree (enforces clean state + merged branch) |
| \`worktreeList\` | List active plugin-managed worktree sessions and git worktrees |

Workflow:
1. \`worktreeCreate\` with a branch name (e.g. feature/dark-mode)
2. Work in the spawned isolated terminal session
3. \`worktreeDelete\` with a reason when done — validates clean state and merged branch first

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

export const WorktreeEnhancedPlugin: Plugin = async ({ client, directory, $ }) => {
	const inRepo = await isGitRepo($, directory)
	const log = makeLogger(client, PLUGIN_MARKER)

	projectRoot = directory
	if (inRepo) {
		db = initStateDb(directory)
		registerCleanupHandlers(db)
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
					`${PLUGIN_MARKER}: prefer worktreeCreate/worktreeDelete/worktreeList over raw git worktree bash`,
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
Prefer: worktreeCreate, worktreeDelete, worktreeList.
Never use raw \`git worktree add/remove\` when plugin tools are available.
Config: .opencode/worktree.jsonc (\`newTerminal\`, \`preserveHistory\`, sync, hooks)
`)
		},

		tool: {
			worktreeCreate: tool({
				description:
					"Create an isolated git worktree and spawn a new terminal with OpenCode (prefer over bash git worktree)",
				args: {
					branch: tool.schema.string().describe("Branch name, e.g. feature/dark-mode"),
					baseBranch: tool.schema
						.string()
						.optional()
						.describe("Base branch to create from (defaults to HEAD)"),
				},
				async execute(args) {
					if (!db || !inRepo) return "Not in a git repository."

					const branchError = validateBranchName(args.branch)
					if (branchError) return `❌ Invalid branch name: ${branchError}`

					if (args.baseBranch) {
						const baseError = validateBranchName(args.baseBranch)
						if (baseError) return `❌ Invalid base branch name: ${baseError}`
					}

					const config = await loadWorktreeConfig(directory, log)

					const result = await createWorktree(
						directory,
						args.branch,
						args.baseBranch,
						config.worktreePath,
					)
					if (!result.ok) return `❌ Failed to create worktree: ${result.error}`

					const worktreePath = result.value

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

					// Launch opencode directly in the worktree directory (fresh session)
					const launchArgv = buildOpenCodeLaunchArgv(worktreePath)
					const terminalResult = await openTerminal(worktreePath, launchArgv, args.branch)

					if (!terminalResult.success) {
						return [
							`⚠️  Worktree created at ${worktreePath}`,
							`Terminal spawn failed: ${terminalResult.error ?? "unknown error"}`,
							"Run `opencode .` manually in the worktree directory.",
						].join("\n")
					}

					addSession(db, {
						id: `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						branch: args.branch,
						path: worktreePath,
						createdAt: new Date().toISOString(),
					})

					return [
						`✅ Worktree created at ${worktreePath}`,
						`Branch: ${args.branch}`,
						`Opened in ${terminalResult.method ?? "a new terminal"}.`,
					].join("\n")
				},
			}),

			worktreeDelete: tool({
				description:
					"Validate and delete the current worktree. Refuses if worktree is dirty or branch is not merged into main. Removes local and remote branch on success.",
				args: {
					reason: tool.schema
						.string()
						.describe("Brief explanation of why you are calling this tool"),
				},
				async execute(_args, toolCtx) {
					if (!db || !inRepo) return "Not in a git repository."

					// Find worktree by matching the current session's directory
					let worktreePath: string | null = null
					try {
						const sessionInfo = await client.session.get({ path: { id: toolCtx.sessionID } })
						if (sessionInfo.data?.directory) {
							worktreePath = sessionInfo.data.directory
						}
					} catch {
						// fall through
					}

					if (!worktreePath) {
						return "No worktree associated with this session. Only worktree sessions created via worktreeCreate can be deleted."
					}

					const session = getSessionByPath(db, worktreePath)
					if (!session) {
						return "No worktree associated with this session. Only worktree sessions created via worktreeCreate can be deleted."
					}

					// ----- Validation phase -----
					// 1. Worktree must have no uncommitted changes
					const cleanResult = await validateWorktreeClean(session.path)
					if (!cleanResult.ok) {
						return `❌ ${cleanResult.error}`
					}

					// 2. Branch must be fully merged into main
					const baseBranch = "main"
					const mergeResult = await validateBranchMerged(directory, session.branch, baseBranch)
					if (!mergeResult.ok) {
						return `❌ ${mergeResult.error}`
					}

					// ----- Cleanup phase -----
					const config = await loadWorktreeConfig(directory, log)
					if (config.hooks.preDelete.length) {
						await runHooks(session.path, config.hooks.preDelete, log)
					}

					// Remove worktree directory
					const removeResult = await removeWorktree(directory, session.path)
					if (!removeResult.ok) {
						return `❌ Failed to remove worktree: ${removeResult.error}`
					}

					// Delete local branch (safe delete — git -d refuses if not merged)
					const branchResult = await deleteLocalBranch(directory, session.branch)
					if (!branchResult.ok) {
						return `⚠️  Worktree removed, but failed to delete branch "${session.branch}": ${branchResult.error}`
					}

					// Delete remote branch (best-effort)
					let remoteDeleted = false
					const remoteResult = await git(["remote"], directory)
					if (remoteResult.ok && remoteResult.value.trim()) {
						const remotes = remoteResult.value.split("\n").filter((r) => r.trim())
						for (const remote of remotes) {
							const pushDeleteResult = await deleteRemoteBranch(directory, session.branch, remote)
							if (pushDeleteResult.ok) {
								remoteDeleted = true
							} else {
								const err = pushDeleteResult.error ?? ""
								if (
									err.includes("remote ref does not exist") ||
									err.includes("could not delete") ||
									err.includes("not match")
								) {
									log.debug(`Remote branch ${remote}/${session.branch} did not exist — skipping`)
								} else {
									log.warn(`Failed to delete remote branch ${remote}/${session.branch}: ${err}`)
								}
							}
						}
					}

					// Clean up session state
					removeSession(db, session.branch)
					clearPendingDelete(db)

					const remoteMsg = remoteDeleted
						? `\n  - Remote branch deleted: origin/${session.branch}`
						: ""
					return [
						`✅ Worktree cleaned up successfully:`,
						`  - Directory removed: ${session.path}`,
						`  - Branch deleted: ${session.branch}${remoteMsg}`,
					].join("\n")
				},
			}),

			worktreeList: tool({
				description:
					"List plugin-managed worktree sessions and git worktrees (prefer over bash git worktree list)",
				args: {
					includeGit: tool.schema
						.boolean()
						.optional()
						.default(true)
						.describe("Include output from git worktree list"),
				},
				async execute(args) {
					if (!db || !inRepo) return "Not in a git repository."

					const sessions = getAllSessions(db)
					const lines: string[] = ["## Plugin-managed sessions"]

					if (!sessions.length) {
						lines.push("(none)")
					} else {
						for (const s of sessions) {
							lines.push(`- ${s.branch} → ${s.path} (session ${s.id}, created ${s.createdAt})`)
						}
					}

					if (args.includeGit) {
						lines.push("", "## Git worktrees")
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
