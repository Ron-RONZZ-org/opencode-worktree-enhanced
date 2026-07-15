/**
 * Shared utilities for opencode-worktree-enhanced.
 * Inlined from kdco-primitives to eliminate external dependency.
 */

import * as os from "node:os"
import * as path from "node:path"

// =============================================================================
// SHELL ESCAPING
// =============================================================================

/** Escape a string for use in a bash single-quoted context. */
export function escapeBash(str: string): string {
	return `'${str.replace(/'/g, "'\\''")}'`
}

/** Escape a string for use in Windows batch file context. */
export function escapeBatch(str: string): string {
	return str
		.replace(/[\^&|<>%!"]/g, "^$&")
		.replace(/\r?\n/g, "\r\n")
		.replace(/%/g, "%%")
}

/** Escape a string for use in AppleScript string context. */
export function escapeAppleScript(str: string): string {
	return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

// =============================================================================
// TEMP DIRECTORY
// =============================================================================

/** Get a writable temp directory path. */
export function getTempDir(): string {
	return process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp"
}

// =============================================================================
// TMUX DETECTION
// =============================================================================

/** Check if running inside a tmux session. */
export function isInsideTmux(): boolean {
	return !!process.env.TMUX
}

// =============================================================================
// MUTEX
// =============================================================================

/**
 * Simple async mutex for serializing tmux operations.
 * Bun's tmux spawns can race on the tmux socket (single-threaded server).
 */
export class Mutex {
	private _locked = false
	private _queue: Array<() => void> = []

	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		await this._acquire()
		try {
			return await fn()
		} finally {
			this._release()
		}
	}

	private _acquire(): Promise<void> {
		if (!this._locked) {
			this._locked = true
			return Promise.resolve()
		}
		return new Promise((resolve) => {
			this._queue.push(resolve)
		})
	}

	private _release(): void {
		const next = this._queue.shift()
		if (next) {
			next()
		} else {
			this._locked = false
		}
	}
}

// =============================================================================
// TIMEOUT
// =============================================================================

/** Error thrown when an operation times out. */
export class TimeoutError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "TimeoutError"
	}
}

/**
 * Race a promise against a timeout.
 * @returns The promise result if it completes in time.
 * @throws {TimeoutError} If the timeout fires first.
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	message?: string,
): Promise<T> {
	let timer: Timer | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new TimeoutError(message || `Operation timed out after ${ms}ms`))
		}, ms)
	})
	try {
		return await Promise.race([promise, timeout])
	} finally {
		clearTimeout(timer)
	}
}

// =============================================================================
// LOGGING
// =============================================================================

/** Minimal logger matching opencode plugin patterns. */
export interface Logger {
	info: (msg: string) => void
	warn: (msg: string) => void
	debug: (msg: string) => void
}

/** Create a logger wrapping an opencode client's log API. */
export function makeLogger(
	client: { app: { log: (opts: { body: { service: string; level: string; message: string } }) => Promise<unknown> } },
	service: string,
): Logger {
	return {
		info: (msg) => client.app.log({ body: { service, level: "info", message: msg } }).catch(() => {}),
		warn: (msg) => client.app.log({ body: { service, level: "warn", message: msg } }).catch(() => {}),
		debug: (msg) => client.app.log({ body: { service, level: "debug", message: msg } }).catch(() => {}),
	}
}
