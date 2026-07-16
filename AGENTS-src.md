# AGENTS-src.md — Source Module Instructions

## Summary
Source code for the opencode-worktree-enhanced plugin. All modules live flat in `src/`. Each module focuses on one domain: git operations, terminal spawning, config loading, state management, etc.

## Modules Overview

| File | Responsibility |
|------|---------------|
| `index.ts` | Plugin entry point — registers `worktreeCreate` / `worktreeDelete` / `worktreeList` tools, config injection, session compaction |
| `git.ts` | All git operations via array-based `Bun.spawn`: worktree CRUD, branch validation, branch delete, remote cleanup |
| `terminal.ts` | Cross-platform terminal spawning: tmux, macOS, Linux, Windows, WSL. Auto-detects current terminal emulator |
| `config.ts` | Loads `.opencode/worktree.jsonc` (JSONC with auto-creation of defaults). Exports `WorktreeConfig` interface |
| `state.ts` | SQLite session database at `~/.local/share/opencode/plugins/worktree/<project-id>.sqlite` |
| `project-id.ts` | Stable, deterministic project ID computed from git root commit SHA or path hash — same from any worktree |
| `sync.ts` | File copy, directory symlink, and hook execution from main worktree to new worktree |
| `validate.ts` | Git branch name validation — blocks control chars, shell metacharacters, git ref special chars |
| `utils.ts` | Shared utilities: shell escaping (bash, batch, AppleScript), mutex, timeout, temp dir, logger |

## Constraints and Invariants

1. **All git commands** go through `src/git.ts`'s `git()` function — array-based `Bun.spawn` only. No shell strings.
2. **State DB is global** (keyed by stable project ID from `project-id.ts`), so all sessions share state.
3. **Terminal spawning** requires no external dependencies — detection uses env vars and `which`-style checks.
4. **Config auto-creates defaults** — if `.opencode/worktree.jsonc` doesn't exist, it's created with helpful comments.
5. **Branch name validation** is defense-in-depth — the `validateBranchName()` check in `src/validate.ts` runs before any git command.
6. **Path traversal** is prevented at every file/symlink operation in `src/sync.ts`.

## Input/Output Expectations

- All modules that interact with git return `Result<T, E>` (defined in `src/git.ts`).
- `WorktreeConfig` is the shared config type — loaded once per command execution.
- Terminal functions return `TerminalResult { success, error?, method? }`.
- Logging uses the `Logger` interface (info, warn, debug) wrapping opencode's `client.app.log`.

## Domain-Specific Rules for Agents

### Adding a new tool
1. Define the tool in `src/index.ts` following the existing pattern (schema + execute).
2. Add supporting logic in the appropriate module (e.g., new git operation → `src/git.ts`).
3. Add tests in `tests/worktree.test.ts` or a new test file.
4. Update the `WORKTREE_TOOLS_GUIDANCE` string and session compaction text in `index.ts`.

### Adding a new terminal type
1. Add detection logic in `detectCurrentMacTerminal()` or `detectCurrentLinuxTerminal()` in `src/terminal.ts`.
2. Add the spawn case in `openMacOSTerminal()` or `openLinuxTerminal()`.
3. Add the terminal name to the `LinuxTerminal` or `MacTerminal` type union.
4. Use `escapeBash()`/`escapeBatch()`/`escapeAppleScript()` for shell arguments.
5. Use `withTempScript()` or `detached` spawn + `unref()` for long-lived processes.

### Modifying state schema
1. Add migration logic in `initStateDb()` in `src/state.ts`.
2. Add corresponding CRUD functions following the existing pattern.
3. Do NOT use external migration tools — Bun's SQLite API is sufficient for this project's schema.
