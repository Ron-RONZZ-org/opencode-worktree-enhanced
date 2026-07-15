/**
 * Cross-platform terminal spawning for opencode-worktree-enhanced.
 *
 * Supports: tmux, macOS (Terminal.app, iTerm, Ghostty, kitty, Alacritty, Warp),
 * Linux (GNOME Terminal, Konsole, XFCE4, kitty, Alacritty, WezTerm, Ghostty,
 * Warp, Foot, xterm, xdg-terminal-exec, x-terminal-emulator),
 * Windows (Windows Terminal, cmd.exe), and WSL.
 *
 * Self-contained — no external dependencies beyond Node/Bun built-ins.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { escapeBash, escapeBatch, escapeAppleScript, getTempDir, isInsideTmux, Mutex, TimeoutError, withTimeout } from "./utils"

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum retries for database initialization */
const CMUX_COMMAND_TIMEOUT_MS = 1500

/** Stabilization delay after spawning tmux windows (ms) */
const STABILIZATION_DELAY_MS = 150

// Singleton mutex for all tmux operations in this process
const tmuxMutex = new Mutex()

// =============================================================================
// TEMP SCRIPT HELPERS
// =============================================================================

/**
 * Execute a function with a temporary script file that is guaranteed to be cleaned up.
 */
async function withTempScript<T>(
	scriptContent: string,
	fn: (scriptPath: string) => Promise<T>,
	extension: string = ".sh",
): Promise<T> {
	const scriptPath = path.join(
		getTempDir(),
		`worktree-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`,
	)
	await Bun.write(scriptPath, scriptContent)
	await fs.chmod(scriptPath, 0o755)

	try {
		return await fn(scriptPath)
	} finally {
		try {
			if (await Bun.file(scriptPath).exists()) {
				await fs.rm(scriptPath)
			}
		} catch {
			// Best-effort cleanup
		}
	}
}

/**
 * Wrap a bash script with trap-based self-cleanup.
 * The script deletes itself on ANY exit.
 */
function wrapWithSelfCleanup(script: string): string {
	return `#!/bin/bash
trap 'rm -f "$0"' EXIT INT TERM
${script}`
}

/**
 * Wrap a batch script with self-cleanup using the goto trick.
 */
function wrapBatchWithSelfCleanup(script: string): string {
	return `@echo off
${script}
(goto) 2>nul & del "%~f0"`
}

// =============================================================================
// WARP LAUNCH CONFIG
// =============================================================================

/** Build Warp launch configuration YAML. */
function buildWarpLaunchConfigYaml(
	name: string,
	cwd: string,
	configPath: string,
	command?: string,
): string {
	const quotedName = JSON.stringify(name)
	const quotedCwd = JSON.stringify(cwd)
	const cleanupCommand = `rm -f "${escapeBash(configPath)}"`
	const commands = [cleanupCommand]
	if (command) {
		commands.push(command)
	}
	const commandsBlock = `\n          commands:${commands
		.map((cmd) => `\n            - exec: ${JSON.stringify(cmd)}`)
		.join("")}`

	return `---
name: ${quotedName}
active_window_index: 0
windows:
  - active_tab_index: 0
    tabs:
      - layout:
          cwd: ${quotedCwd}${commandsBlock}
`
}

/** Get Warp launch configuration directory. */
function getWarpLaunchConfigDir(): string {
	const xdgDataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
	return path.join(xdgDataHome, "warp-terminal", "launch_configurations")
}

// =============================================================================
// TYPES
// =============================================================================

/** Result of a terminal operation */
export interface TerminalResult {
	success: boolean
	error?: string
	/** Human-readable description (e.g. "new tmux window", "tab in kitty") */
	method?: string
}

type TerminalType = "tmux" | "macos" | "windows" | "linux-desktop"

// =============================================================================
// PLATFORM DETECTION
// =============================================================================

/** Check if running inside WSL (Windows Subsystem for Linux). */
function isInsideWSL(): boolean {
	const hasWslEnv = !!(process.env.WSL_DISTRO_NAME || process.env.WSLENV)
	if (hasWslEnv) return true
	try {
		return os.release().toLowerCase().includes("microsoft")
	} catch {
		return false
	}
}

type PlatformTerminalType = Exclude<TerminalType, "tmux">

function detectPlatformTerminalType(): PlatformTerminalType {
	if (process.platform === "linux" && isInsideWSL()) {
		return "windows"
	}
	switch (process.platform) {
		case "darwin":
			return "macos"
		case "win32":
			return "windows"
		case "linux":
			return "linux-desktop"
		default:
			return "linux-desktop"
	}
}

/** Detect the best terminal type for the current platform. Priority: tmux > platform. */
export function detectTerminalType(): TerminalType {
	if (isInsideTmux()) return "tmux"
	return detectPlatformTerminalType()
}

// =============================================================================
// TMUX OPERATIONS (MUTEX-PROTECTED)
// =============================================================================

/**
 * Open a new tmux window with mutex protection.
 * Includes stabilization delay to prevent races on the tmux socket.
 */
export async function openTmuxWindow(options: {
	sessionName?: string
	windowName: string
	cwd: string
	argv?: string[]
}): Promise<TerminalResult> {
	const { sessionName, windowName, cwd, argv } = options
	const command = argv?.length ? argv.map((a) => `"${escapeBash(a)}"`).join(" ") : undefined

	return tmuxMutex.runExclusive(async () => {
		try {
			const tmuxArgs: string[] = ["new-window", "-n", windowName, "-c", cwd, "-P", "-F", "#{pane_id}"]

			if (sessionName) {
				tmuxArgs.splice(1, 0, "-t", sessionName)
			}

			if (command) {
				const scriptPath = path.join(getTempDir(), `worktree-${Bun.randomUUIDv7()}.sh`)
				const escapedCwd = escapeBash(cwd)
				const scriptContent = wrapWithSelfCleanup(
					`cd "${escapedCwd}" || exit 1\n${command}\nexec $SHELL`,
				)
				await Bun.write(scriptPath, scriptContent)
				Bun.spawnSync(["chmod", "+x", scriptPath])
				tmuxArgs.push("--", "bash", scriptPath)
			}

			const createResult = Bun.spawnSync(["tmux", ...tmuxArgs])

			if (createResult.exitCode !== 0) {
				return {
					success: false,
					error: `Failed to create tmux window: ${createResult.stderr.toString()}`,
				}
			}

			await Bun.sleep(STABILIZATION_DELAY_MS)
			return { success: true, method: "new tmux window" }
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			}
		}
	})
}

// =============================================================================
// MACOS TERMINAL
// =============================================================================

type MacTerminal = "ghostty" | "iterm" | "warp" | "kitty" | "alacritty" | "terminal"

/** Detect the current macOS terminal from environment variables. */
function detectCurrentMacTerminal(): MacTerminal {
	const env = process.env

	if (env.GHOSTTY_RESOURCES_DIR) return "ghostty"
	if (env.ITERM_SESSION_ID) return "iterm"
	if (env.KITTY_WINDOW_ID) return "kitty"
	if (env.ALACRITTY_WINDOW_ID) return "alacritty"
	if (env.__CFBundleIdentifier === "dev.warp.Warp-Stable") return "warp"

	const termProgram = env.TERM_PROGRAM?.toLowerCase()
	switch (termProgram) {
		case "ghostty": return "ghostty"
		case "iterm.app": return "iterm"
		case "warpterm": return "warp"
		case "apple_terminal": return "terminal"
	}
	return "terminal"
}

/**
 * Open terminal on macOS (Terminal.app, iTerm, Ghostty, etc.)
 * Detects current terminal and uses the appropriate method.
 */
export async function openMacOSTerminal(cwd: string, argv?: string[]): Promise<TerminalResult> {
	if (!cwd) {
		return { success: false, error: "Working directory is required" }
	}

	const escapedCwd = escapeBash(cwd)
	const command = argv?.length
		? argv.map((a) => `"${escapeBash(a)}"`).join(" ")
		: undefined
	const scriptContent = wrapWithSelfCleanup(
		command
			? `cd "${escapedCwd}" && ${command}\nexec bash`
			: `cd "${escapedCwd}"\nexec bash`,
	)

	const terminal = detectCurrentMacTerminal()
	let detachedScriptPath: string | null = null

	try {
		switch (terminal) {
			case "ghostty": {
				try {
					const proc = Bun.spawn(
						["open", "-na", "Ghostty.app", "--args", `--working-directory=${cwd}`, "-e", "bash", "-c",
						 command ? `cd "${escapedCwd}" && ${command}` : `cd "${escapedCwd}"`],
						{ detached: true, stdio: ["ignore", "ignore", "ignore"] },
					)
					proc.unref()
					return { success: true, method: "new Ghostty window" }
				} catch (error) {
					return { success: false, error: error instanceof Error ? error.message : String(error) }
				}
			}

			case "kitty": {
				const remoteResult = await withTempScript(scriptContent, async (sp) => {
					const result = Bun.spawnSync(["kitty", "@", "launch", "--type", "tab", "--cwd", cwd, "--", "bash", sp])
					return result.exitCode === 0
				})
				if (remoteResult) {
					return { success: true, method: "tab in kitty" }
				}
				// Fallback: new window
				detachedScriptPath = path.join(getTempDir(), `worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
				await Bun.write(detachedScriptPath, scriptContent)
				await fs.chmod(detachedScriptPath, 0o755)
				const kittyProc = Bun.spawn(["kitty", "--directory", cwd, "-e", "bash", detachedScriptPath],
					{ detached: true, stdio: ["ignore", "ignore", "ignore"] })
				kittyProc.unref()
				detachedScriptPath = null
				return { success: true, method: "new kitty window" }
			}

			case "alacritty": {
				detachedScriptPath = path.join(getTempDir(), `worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
				await Bun.write(detachedScriptPath, scriptContent)
				await fs.chmod(detachedScriptPath, 0o755)
				const alacrittyProc = Bun.spawn(["alacritty", "--working-directory", cwd, "-e", "bash", detachedScriptPath],
					{ detached: true, stdio: ["ignore", "ignore", "ignore"] })
				alacrittyProc.unref()
				detachedScriptPath = null
				return { success: true, method: "new Alacritty window" }
			}

			case "warp": {
				detachedScriptPath = path.join(getTempDir(), `worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
				await Bun.write(detachedScriptPath, scriptContent)
				await fs.chmod(detachedScriptPath, 0o755)
				const warpProc = Bun.spawn(["open", "-b", "dev.warp.Warp-Stable", detachedScriptPath],
					{ detached: true, stdio: ["ignore", "ignore", "ignore"] })
				warpProc.unref()
				detachedScriptPath = null
				return { success: true, method: "new Warp window" }
			}

			case "iterm": {
				detachedScriptPath = path.join(getTempDir(), `worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
				await Bun.write(detachedScriptPath, scriptContent)
				await fs.chmod(detachedScriptPath, 0o755)
				const escapedPath = escapeAppleScript(detachedScriptPath)
				const appleScript = `
				tell application "iTerm"
					if not (exists window 1) then
						reopen
					else
						tell current window
							create tab with default profile
						end tell
					end if
					activate
					tell first session of current tab of current window
						write text "${escapedPath}"
					end tell
				end tell`
				const result = Bun.spawnSync(["osascript", "-e", appleScript])
				if (result.exitCode !== 0) {
					try { await fs.rm(detachedScriptPath) } catch { /* best-effort */ }
					return { success: false, error: `iTerm AppleScript failed: ${result.stderr.toString()}` }
				}
				detachedScriptPath = null
				return { success: true, method: "tab in iTerm" }
			}

			default: {
				// Terminal.app
				return await withTempScript(scriptContent, async (sp) => {
					const proc = Bun.spawn(["open", "-a", "Terminal", sp],
						{ stdio: ["ignore", "ignore", "pipe"] })
					const exitCode = await proc.exited
					if (exitCode !== 0) {
						const stderr = await new Response(proc.stderr).text()
						return { success: false, error: `Failed to open Terminal: ${stderr}` }
					}
					return { success: true, method: "new Terminal.app window" }
				})
			}
		}
	} catch (error) {
		if (detachedScriptPath) {
			try { await fs.rm(detachedScriptPath) } catch { /* best-effort */ }
		}
		return { success: false, error: `Failed to open terminal: ${error instanceof Error ? error.message : String(error)}` }
	}
}

// =============================================================================
// LINUX TERMINAL
// =============================================================================

type LinuxTerminal =
	| "kitty" | "wezterm" | "alacritty" | "ghostty" | "warp" | "foot"
	| "gnome-terminal" | "konsole" | "xfce4-terminal"
	| "xdg-terminal-exec" | "x-terminal-emulator" | "xterm"

/** Detect the current Linux terminal from environment variables. */
function detectCurrentLinuxTerminal(): LinuxTerminal | null {
	const env = process.env

	if (env.KITTY_WINDOW_ID) return "kitty"
	if (env.WEZTERM_PANE) return "wezterm"
	if (env.ALACRITTY_WINDOW_ID) return "alacritty"
	if (env.GHOSTTY_RESOURCES_DIR) return "ghostty"
	if (env.GNOME_TERMINAL_SERVICE) return "gnome-terminal"
	if (env.KONSOLE_VERSION) return "konsole"

	const termProgram = env.TERM_PROGRAM?.toLowerCase()
	if (termProgram === "warpterminal") return "warp"
	if (termProgram === "foot") return "foot"

	return null
}

/**
 * Open terminal on Linux with desktop environment detection.
 * Priority: current terminal > xdg-terminal-exec > x-terminal-emulator > modern > DE > xterm
 */
export async function openLinuxTerminal(cwd: string, argv?: string[]): Promise<TerminalResult> {
	if (!cwd) {
		return { success: false, error: "Working directory is required" }
	}

	const escapedCwd = escapeBash(cwd)
	const command = argv?.length
		? argv.map((a) => `"${escapeBash(a)}"`).join(" ")
		: undefined
	const scriptContent = wrapWithSelfCleanup(
		command
			? `cd "${escapedCwd}" && ${command}\nexec bash`
			: `cd "${escapedCwd}"\nexec bash`,
	)

	let scriptPath: string | null = null
	let warpConfigPath: string | null = null

	const cleanupFile = async (fp: string | null) => {
		if (!fp) return
		try { await fs.rm(fp) } catch { /* best-effort */ }
	}

	const ensureScriptPath = async (): Promise<string> => {
		if (scriptPath) return scriptPath
		scriptPath = path.join(getTempDir(), `worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
		await Bun.write(scriptPath, scriptContent)
		await fs.chmod(scriptPath, 0o755)
		return scriptPath
	}

	try {
		const tryTerminal = async (name: string, args: string[]): Promise<boolean> => {
			const check = Bun.spawnSync(["which", name])
			if (check.exitCode !== 0) return false
			try {
				const proc = Bun.spawn(args, { detached: true, stdio: ["ignore", "ignore", "ignore"] })
				proc.unref()
				return true
			} catch {
				return false
			}
		}

		// 1. Check current terminal via env detection
		const currentTerminal = detectCurrentLinuxTerminal()
		if (currentTerminal) {
			switch (currentTerminal) {
				case "kitty": {
					const launchSp = await ensureScriptPath()
					const kittyRemote = Bun.spawnSync(["kitty", "@", "launch", "--type", "tab", "--cwd", cwd, "--", "bash", launchSp])
					if (kittyRemote.exitCode === 0) return { success: true, method: "tab in kitty" }
					if (await tryTerminal("kitty", ["kitty", "--directory", cwd, "-e", "bash", launchSp]))
						return { success: true, method: "new kitty window" }
					break
				}
				case "wezterm": {
					const launchSp = await ensureScriptPath()
					if (await tryTerminal("wezterm", ["wezterm", "cli", "spawn", "--cwd", cwd, "--", "bash", launchSp]))
						return { success: true, method: "tab in WezTerm" }
					break
				}
				case "alacritty": {
					const launchSp = await ensureScriptPath()
					if (await tryTerminal("alacritty", ["alacritty", "--working-directory", cwd, "-e", "bash", launchSp]))
						return { success: true, method: "new Alacritty window" }
					break
				}
				case "ghostty": {
					const launchSp = await ensureScriptPath()
					if (await tryTerminal("ghostty", ["ghostty", "-e", "bash", launchSp]))
						return { success: true, method: "new Ghostty window" }
					break
				}
				case "warp": {
					const configName = `worktree-${Date.now()}-${Math.random().toString(36).slice(2)}`
					const configDir = getWarpLaunchConfigDir()
					const configPath_ = path.join(configDir, `${configName}.yaml`)
					warpConfigPath = configPath_
					const configContent = buildWarpLaunchConfigYaml(configName, cwd, configPath_, command)
					await fs.mkdir(configDir, { recursive: true })
					await Bun.write(configPath_, configContent)
					if (await tryTerminal("warp-terminal", ["warp-terminal", `warp://launch/${encodeURIComponent(configName)}`]))
						return { success: true, method: "new Warp window" }
					if (await tryTerminal("warp-terminal", ["warp-terminal", `warp://launch/${encodeURIComponent(`${configName}.yaml`)}`]))
						return { success: true, method: "new Warp window" }
					await cleanupFile(warpConfigPath)
					warpConfigPath = null
					break
				}
				case "foot": {
					const launchSp = await ensureScriptPath()
					if (await tryTerminal("foot", ["foot", "--working-directory", cwd, "bash", launchSp]))
						return { success: true, method: "new Foot window" }
					break
				}
				case "gnome-terminal": {
					const launchSp = await ensureScriptPath()
					if (await tryTerminal("gnome-terminal", ["gnome-terminal", "--working-directory", cwd, "--", "bash", launchSp]))
						return { success: true, method: "new GNOME Terminal window" }
					break
				}
				case "konsole": {
					const launchSp = await ensureScriptPath()
					if (await tryTerminal("konsole", ["konsole", "--workdir", cwd, "-e", "bash", launchSp]))
						return { success: true, method: "new Konsole window" }
					break
				}
				default:
					break
			}
		}

		// 2. Fallback chain
		const launchSp = await ensureScriptPath()

		if (await tryTerminal("xdg-terminal-exec", ["xdg-terminal-exec", "--", "bash", launchSp]))
			return { success: true, method: "new xdg-terminal-exec window" }
		if (await tryTerminal("x-terminal-emulator", ["x-terminal-emulator", "-e", "bash", launchSp]))
			return { success: true, method: "new x-terminal-emulator window" }

		const modernFallbacks: Array<[string, string[]]> = [
			["kitty", ["kitty", "--directory", cwd, "-e", "bash", launchSp]],
			["alacritty", ["alacritty", "--working-directory", cwd, "-e", "bash", launchSp]],
			["wezterm", ["wezterm", "cli", "spawn", "--cwd", cwd, "--", "bash", launchSp]],
			["ghostty", ["ghostty", "-e", "bash", launchSp]],
			["foot", ["foot", "--working-directory", cwd, "bash", launchSp]],
		]
		for (const [name, args] of modernFallbacks) {
			if (await tryTerminal(name, args)) return { success: true, method: `new ${name} window` }
		}

		const deFallbacks: Array<[string, string[]]> = [
			["gnome-terminal", ["gnome-terminal", "--working-directory", cwd, "--", "bash", launchSp]],
			["konsole", ["konsole", "--workdir", cwd, "-e", "bash", launchSp]],
			["xfce4-terminal", ["xfce4-terminal", "--working-directory", cwd, "-x", "bash", launchSp]],
		]
		for (const [name, args] of deFallbacks) {
			if (await tryTerminal(name, args)) return { success: true, method: `new ${name} window` }
		}

		if (await tryTerminal("xterm", ["xterm", "-e", "bash", launchSp]))
			return { success: true, method: "new xterm window" }

		await cleanupFile(scriptPath)
		await cleanupFile(warpConfigPath)
		scriptPath = null
		warpConfigPath = null
		return { success: false, error: "No terminal emulator found" }
	} catch (error) {
		await cleanupFile(scriptPath)
		await cleanupFile(warpConfigPath)
		return { success: false, error: `Failed to spawn terminal: ${error instanceof Error ? error.message : String(error)}` }
	}
}

// =============================================================================
// WINDOWS TERMINAL
// =============================================================================

/** Open terminal on Windows (Windows Terminal or cmd.exe). */
export async function openWindowsTerminal(cwd: string, argv?: string[]): Promise<TerminalResult> {
	if (!cwd) return { success: false, error: "Working directory is required" }

	const escapedCwd = escapeBatch(cwd)
	const command = argv?.length
		? argv.map((a) => `"${escapeBatch(a).replace(/"/g, '""')}"`).join(" ")
		: undefined
	const scriptContent = wrapBatchWithSelfCleanup(
		command
			? `cd /d "${escapedCwd}"\r\n${command}\r\ncmd /k`
			: `cd /d "${escapedCwd}"\r\ncmd /k`,
	)
	const scriptPath = path.join(getTempDir(), `worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.bat`)
	await Bun.write(scriptPath, scriptContent)
	await fs.chmod(scriptPath, 0o755)

	try {
		const wtCheck = Bun.spawnSync(["where", "wt"], { stdout: "pipe", stderr: "pipe" })
		if (wtCheck.exitCode === 0) {
			try {
				const proc = Bun.spawn(["wt.exe", "-d", cwd, "cmd", "/k", scriptPath],
					{ detached: true, stdio: ["ignore", "ignore", "ignore"] })
				proc.unref()
				return { success: true, method: "new Windows Terminal window" }
			} catch { /* fall through */ }
		}
		try {
			const proc = Bun.spawn(["cmd", "/c", "start", "", scriptPath],
				{ detached: true, stdio: ["ignore", "ignore", "ignore"] })
			proc.unref()
			return { success: true, method: "new cmd window" }
		} catch (error) {
			try { await fs.rm(scriptPath) } catch { /* best-effort */ }
			return { success: false, error: error instanceof Error ? error.message : String(error) }
		}
	} catch (error) {
		return { success: false, error: `Failed to spawn terminal: ${error instanceof Error ? error.message : String(error)}` }
	}
}

// =============================================================================
// WSL TERMINAL
// =============================================================================

/** Open terminal in WSL via Windows Terminal interop. */
export async function openWSLTerminal(cwd: string, argv?: string[]): Promise<TerminalResult> {
	if (!cwd) return { success: false, error: "Working directory is required" }

	const escapedCwd = escapeBash(cwd)
	const command = argv?.length
		? argv.map((a) => `"${escapeBash(a)}"`).join(" ")
		: undefined
	const scriptContent = wrapWithSelfCleanup(
		command
			? `cd "${escapedCwd}" && ${command}\nexec bash`
			: `cd "${escapedCwd}"\nexec bash`,
	)
	const scriptPath = path.join(getTempDir(), `worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
	await Bun.write(scriptPath, scriptContent)
	await fs.chmod(scriptPath, 0o755)

	try {
		const wtResult = Bun.spawnSync(["which", "wt.exe"])
		if (wtResult.exitCode === 0) {
			try {
				const proc = Bun.spawn(["wt.exe", "-d", cwd, "bash", scriptPath],
					{ detached: true, stdio: ["ignore", "ignore", "ignore"] })
				proc.unref()
				return { success: true, method: "new Windows Terminal (WSL)" }
			} catch { /* fall through */ }
		}
		try {
			const proc = Bun.spawn(["bash", scriptPath],
				{ cwd, detached: true, stdio: ["ignore", "ignore", "ignore"] })
			proc.unref()
			return { success: true, method: "bash in current terminal" }
		} catch (error) {
			try { await fs.rm(scriptPath) } catch { /* best-effort */ }
			return { success: false, error: error instanceof Error ? error.message : String(error) }
		}
	} catch (error) {
		return { success: false, error: `Failed to spawn terminal: ${error instanceof Error ? error.message : String(error)}` }
	}
}

// =============================================================================
// UNIFIED TERMINAL OPENING
// =============================================================================

/**
 * Open a terminal window on the current platform.
 * Automatically detects the best terminal type and method.
 *
 * @param cwd - Working directory for the terminal
 * @param argv - Optional command to execute (e.g., ["opencode", "."])
 * @param windowName - Optional window name (used for tmux)
 * @returns Result with success status and description
 */
export async function openTerminal(
	cwd: string,
	argv?: string[],
	windowName?: string,
): Promise<TerminalResult> {
	if (isInsideTmux()) {
		return openTmuxWindow({
			windowName: windowName || "worktree",
			cwd,
			argv,
		})
	}

	const platformTerminalType = detectPlatformTerminalType()

	switch (platformTerminalType) {
		case "macos":
			return openMacOSTerminal(cwd, argv)
		case "windows":
			if (process.platform === "linux" && isInsideWSL()) {
				return openWSLTerminal(cwd, argv)
			}
			return openWindowsTerminal(cwd, argv)
		case "linux-desktop":
			return openLinuxTerminal(cwd, argv)
		default:
			return { success: false, error: `Unsupported terminal type: ${platformTerminalType}` }
	}
}

/** Build the argv to launch opencode in a worktree directory. */
export function buildOpenCodeLaunchArgv(worktreePath: string): string[] {
	return ["opencode", worktreePath]
}
