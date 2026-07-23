/**
 * Tests for terminal.ts — buildOpenCodeLaunchArgv and getOpenCodeBinaryPath.
 *
 * Run with: bun test tests/terminal.test.ts
 */
import { describe, expect, test } from "bun:test"
import { buildOpenCodeLaunchArgv, getOpenCodeBinaryPath } from "../src/terminal"
import { readlinkSync } from "node:fs"
import * as path from "node:path"

describe("getOpenCodeBinaryPath", () => {
	test("returns a non-empty string", () => {
		const result = getOpenCodeBinaryPath()
		expect(result.length).toBeGreaterThan(0)
	})

	test("returns the same value on repeated calls (cached)", () => {
		const a = getOpenCodeBinaryPath()
		const b = getOpenCodeBinaryPath()
		expect(a).toBe(b)
	})

	test("returns the running opencode binary when available", () => {
		const result = getOpenCodeBinaryPath()
		if (process.platform === "linux") {
			try {
				const exePath = readlinkSync("/proc/self/exe")
				const binName = path.basename(exePath)
				if (binName === "opencode" || binName === "opencode.exe") {
					// Running inside opencode — must resolve to the actual binary path
					expect(result).toBe(exePath)
				} else {
					// Running under bun/node — result is either from Bun.which or fallback
					expect(result.length).toBeGreaterThan(0)
				}
			} catch {
				expect(result.length).toBeGreaterThan(0)
			}
		} else {
			expect(result.length).toBeGreaterThan(0)
		}
	})
})

describe("buildOpenCodeLaunchArgv", () => {
	const worktreePath = "/tmp/worktrees/feature/my-feature"
	const opencodePath = getOpenCodeBinaryPath()

	test("without serverUrl: returns standalone opencode command", () => {
		const result = buildOpenCodeLaunchArgv(worktreePath)
		expect(result).toEqual([opencodePath, worktreePath])
	})

	test("with serverUrl: returns attach command with --dir", () => {
		const serverUrl = "http://127.0.0.1:4096"
		const result = buildOpenCodeLaunchArgv(worktreePath, serverUrl)
		expect(result).toEqual([opencodePath, "attach", serverUrl, "--dir", worktreePath])
	})

	test("with serverUrl on different port: preserves the URL", () => {
		const serverUrl = "http://127.0.0.1:8080"
		const result = buildOpenCodeLaunchArgv(worktreePath, serverUrl)
		expect(result).toEqual([opencodePath, "attach", serverUrl, "--dir", worktreePath])
	})

	test("with serverUrl containing path: preserves the URL", () => {
		const serverUrl = "http://192.168.1.100:4096/opencode"
		const result = buildOpenCodeLaunchArgv(worktreePath, serverUrl)
		expect(result).toEqual([opencodePath, "attach", serverUrl, "--dir", worktreePath])
	})
})
