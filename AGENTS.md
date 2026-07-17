# AGENTS.md — Root Project Rules for opencode-worktree-enhanced

This is the canonical, repo-wide instruction file for AI agents working on **opencode-worktree-enhanced**.

## Hierarchical Context Model

Agents **must** follow this rule:

> When working inside a directory, load the nearest `AGENTS.md` file and merge it with parent `AGENTS.md` files up to root.
> Local rules override global rules.

Context resolution order (highest priority first):
1. `AGENTS-[module].md` in module directories — module-specific context
2. `AGENTS.md` in current working directory (if present)
3. Root `AGENTS.md` — global project rules

---
## Project Overview

**opencode-worktree-enhanced** is a standalone [opencode](https://github.com/anomalyco/opencode) plugin that provides three dedicated tools (`worktreeCreate`, `worktreeDelete`, `worktreeList`) for managing git worktrees with validation, remote cleanup, and cross-platform terminal spawning.

It replaces ad-hoc `git worktree` bash commands with a structured workflow:
1. `worktreeCreate` — Create an isolated worktree + spawn OpenCode in a new terminal
2. Work in the spawned session
3. `worktreeDelete` — Validates clean state + merged branch, then removes worktree, deletes local & remote branches

Key design principles:
- **State is shared globally** via a SQLite DB keyed by a stable project ID, so parent and worktree sessions share one state database
- **No shell injection**: all git commands use array-based `Bun.spawn`
- **Cross-platform terminal spawning**: supports tmux, macOS (Terminal.app, iTerm, Ghostty, kitty, Alacritty, Warp), Linux (GNOME Terminal, Konsole, XFCE4, kitty, Alacritty, WezTerm, Ghostty, Warp, Foot, xterm), and Windows (Windows Terminal, cmd.exe)
- **Configurable via `.opencode/worktree.jsonc`** with auto-creation of defaults

---

## Language and Naming Conventions

- **Language**: TypeScript (strict mode, ESNext target)
- **Naming**: camelCase for functions and variables, PascalCase for classes and types, UPPER_CASE for constants
- **File naming**: kebab-case (`project-id.ts`, not `projectId.ts`)
- **Use `import type` for type-only imports**
- All exports should be named (no `export default` except for the plugin export in `index.ts`)

## Tech Stack

| Aspect | Choice |
|--------|--------|
| Runtime | [Bun](https://bun.sh) |
| Plugin framework | `@opencode-ai/plugin` |
| Database | `bun:sqlite` (SQLite built into Bun) |
| Config format | JSONC (via `jsonc-parser`) |
| Test framework | `bun:test` |
| Module system | ESM (`"type": "module"` in package.json) |

## Dependency management

This project uses **npm** for dependency management and **Bun** for running and testing. Install dependencies with `npm install`. Run with `bun`.

## Coding Guidelines

1. **All git commands must use array-based `Bun.spawn`** — never shell string interpolation. The `git()` function in `src/git.ts` is the canonical way to execute git commands.
2. **Use the `Result<T, E>` pattern** for all operations that can fail — never throw exceptions for expected failure modes. The `Result` type is defined in `src/git.ts` with `Result.ok()` and `Result.err()` constructors.
3. **Path traversal protection**: any operation that copies files, creates symlinks, or writes to disk must validate that paths do not escape the worktree root. Use `isPathSafe()`, `resolveExistingPathWithinRoot()`, and `ensureDirectoryWithinRoot()` from `src/sync.ts`.
4. **Shell escaping**: use `escapeBash()`, `escapeBatch()`, and `escapeAppleScript()` from `src/utils.ts` whenever constructing shell commands dynamically.
5. **Temp file cleanup**: wrap temp script creation with `withTempScript()` or use `wrapWithSelfCleanup()` to ensure scripts self-delete.
6. **Tmux operations must use the `tmuxMutex`** from `src/terminal.ts` — tmux has a single-threaded server and concurrent spawns can race on the socket.
7. **No synchronous filesystem operations except during initialization** (e.g., `mkdirSync` in `initStateDb()`). Use `fs/promises` everywhere else.

## Documentation Standards

- **Every module must have a corresponding `AGENTS-[module].md` file.**
- **Every tool must have a clear description and documented argument schema** in the plugin definition (`src/index.ts`).
- **Error messages must guide the user to resolution** — include actionable tips (e.g., "Commit or stash them before calling `worktreeDelete`").

---

## Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`

---

## Testing Requirements

### Test Framework & Execution

| Aspect | Convention |
|--------|-----------|
| Framework | `bun:test` |
| Run all tests | `bun test tests/` |
| Run single test file | `bun test tests/worktree.test.ts` |
| Test directory | `tests/` |

### Testing Principles

1. **Tests operate on ephemeral sandbox repos** created in `/tmp/worktree-enhanced-test-*`. Each test suite creates its own repo, and `afterAll` cleans up with `fs.rmSync(path, { recursive: true, force: true })`.
2. **Use `execSync` for git setup** (creating repos, committing, merging) and `async` functions for testing the plugin's own async APIs.
3. **Do not test directly via backend API alone — test through the user-facing interface** (the exported functions from `src/` modules).
4. **Test both success and failure paths** — every function that returns `Result<T, E>` should have tests for both `ok: true` and `ok: false` cases.
5. **Every bug fix must include a test that would have caught the regression.**

---

## What to Avoid

- Do not use `child_process.exec` / `child_process.spawn` with shell strings — always use array-based `Bun.spawn` or the `git()` helper
- Do not add dependencies on `fs` over `fs/promises` (except in `state.ts` where `mkdirSync` is unavoidable during init)
- Do not add external shell-escape libraries — the escape functions in `utils.ts` are purpose-built and tested
- Do not write to `.git` directory directly — use `git` commands through the `git()` helper

---

## Module-Level AGENTS Files

The following module-specific AGENTS files are located in their respective directories:

| Module | AGENTS File | Description |
|--------|-------------|-------------|
| src | `AGENTS-src.md` | Source code modules (plugin entry, git ops, terminal, config, state, validation, utils, sync, project-id) |
| tests | `AGENTS-tests.md` | Test suite conventions |

(Update this table as new modules are added)

---

## Dependency and Inheritance Map

```
Root AGENTS.md (global rules)
    │
    ├── AGENTS-src.md (source module rules)
    └── AGENTS-tests.md (testing conventions)
```

Local rules override global rules. Module-level files focus on domain-specific behavior, constraints, and invariants.

## References

For doc on opencode APIs, etc.: https://opencode.ai/docs
For opencode source code: https://github.com/anomalyco/opencode
For inspirations, see source code of similar plugin: https://github.com/stevenke1981/opencode-worktree-tools
  - this is the inspiration for our plug-in
  - be critical: their implementation have limitations. We can often do better.
