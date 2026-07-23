/**
 * Tests for terminal.ts — buildOpenCodeLaunchArgv.
 *
 * Run with: bun test tests/terminal.test.ts
 */
import { describe, expect, test } from "bun:test"
import { buildOpenCodeLaunchArgv } from "../src/terminal"

describe("buildOpenCodeLaunchArgv", () => {
	const worktreePath = "/tmp/worktrees/feature/my-feature"

	test("without serverUrl: returns standalone opencode command", () => {
		const result = buildOpenCodeLaunchArgv(worktreePath)
		expect(result).toEqual(["opencode", worktreePath])
	})

	test("with serverUrl: returns attach command with --dir", () => {
		const serverUrl = "http://127.0.0.1:4096"
		const result = buildOpenCodeLaunchArgv(worktreePath, serverUrl)
		expect(result).toEqual(["opencode", "attach", serverUrl, "--dir", worktreePath])
	})

	test("with serverUrl on different port: preserves the URL", () => {
		const serverUrl = "http://127.0.0.1:8080"
		const result = buildOpenCodeLaunchArgv(worktreePath, serverUrl)
		expect(result).toEqual(["opencode", "attach", serverUrl, "--dir", worktreePath])
	})

	test("with serverUrl containing path: preserves the URL", () => {
		const serverUrl = "http://192.168.1.100:4096/opencode"
		const result = buildOpenCodeLaunchArgv(worktreePath, serverUrl)
		expect(result).toEqual(["opencode", "attach", serverUrl, "--dir", worktreePath])
	})
})
