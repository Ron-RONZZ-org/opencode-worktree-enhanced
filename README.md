# opencode-worktree-enhanced

> A standalone [opencode](https://github.com/Ron-RONZZ-org/opencode) plugin for creating, deleting, and listing git worktrees with validation, remote cleanup, and cross-platform terminal support.

## Features

- **`worktreeCreate`** — Create an isolated git worktree and spawn a new terminal with opencode ready to go
- **`worktreeDelete`** — Safely delete a worktree with two-tier validation (clean working tree + branch merged check), remote branch cleanup, and a `--force` escape hatch for squash-merged branches
- **`worktreeList`** — List all plugin-managed sessions and git worktrees in one view
- **Cross-platform terminal spawning** — Automatically detects and opens new tabs/windows in Kitty, Alacritty, Ghostty, WezTerm, Warp, Foot, GNOME Terminal, Konsole, XFCE4, Terminal.app, iTerm, Windows Terminal, and more
- **Shared global state** — A SQLite database keyed by stable project ID ensures parent and worktree sessions always see the same sessions list
- **Configurable sync** — Copy files and symlink directories from main worktree into new worktrees; run hooks on create/delete
- **No shell injection** — All git commands use array-based `Bun.spawn`
- **Auto-created config** — `.opencode/worktree.jsonc` is created with defaults and helpful comments on first use

## Installation

```bash
# Install dependencies
npm install

# The plugin must be registered in your opencode configuration:
# ~/.config/opencode/opencode.jsonc
# or ./opencode.jsonc
```

Add to your opencode configuration:

```jsonc
{
  "plugins": {
    "worktree": {
      "kind": "file",
      "path": "/path/to/opencode-worktree-enhanced/src/index.ts"
    }
  }
}
```

## Usage

The plugin injects a `<WORKTREE_TOOLS_PLUGIN>` guidance block into every conversation's first user message inside a git repository, and registers three tools:

### `worktreeCreate`

```txt
worktreeCreate branch: "feature/my-feature" baseBranch: "main"
```

1. Validates the branch name
2. Creates a git worktree in `~/.local/share/opencode/worktree/<project>/<branch>/`
3. Syncs configured files/directories
4. Runs post-create hooks
5. Spawns a new terminal with `opencode <worktree-path>`
6. Records the session in the global state DB

### `worktreeDelete`

```txt
worktreeDelete reason: "PR merged, cleaning up"
worktreeDelete reason: "squash merged on GitHub" --force  # escape hatch
```

1. Finds the worktree associated with the current opencode session
2. Validates the worktree has no uncommitted changes
3. Validates the branch is fully merged into `main` (two-tier: ancestry + content diff)
4. Runs pre-delete hooks
5. Removes the worktree directory
6. Deletes the local branch
7. Best-effort remote branch deletion
8. Cleans up the session record

### `worktreeList`

```txt
worktreeList includeGit: true
```

Lists all plugin-managed sessions and optionally includes raw `git worktree list` output.

## Configuration

The config file is auto-created at `.opencode/worktree.jsonc` in your project root when the plugin first runs:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Ron-RONZZ-org/opencode-worktree-enhanced/main/schema.json",

  // Custom base path for worktree storage (supports ~)
  // Default: ~/.local/share/opencode/worktree
  // "worktreePath": "~/my-worktrees",

  "sync": {
    // Files to copy from main worktree to new worktrees
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
```

## Architecture

```
                  ┌─────────────┐
                  │  index.ts   │  Plugin entry, tool definitions
                  └──────┬──────┘
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌──────────┐   ┌────────────┐   ┌──────────────┐
   │  git.ts  │   │ terminal.ts│   │   state.ts   │
   │ git ops  │   │  terminals │   │  SQLite DB   │
   └──────────┘   └────────────┘   └──────┬───────┘
                                          │
                                   ┌──────┴───────┐
                                   │ project-id.ts│
                                   │  stable ID   │
                                   └──────────────┘
   ┌──────────┐   ┌────────────┐   ┌──────────────┐
   │config.ts │   │  sync.ts   │   │  validate.ts  │
   │ JSONC    │   │copy/symlink│   │ branch names  │
   └──────────┘   └────────────┘   └──────────────┘

   ┌──────────┐
   │utils.ts  │  Escaping, mutex, logging, temp dir
   └──────────┘
```

## State Database

All sessions are stored in a single global SQLite database at:

```
~/.local/share/opencode/plugins/worktree/<project-id>.sqlite
```

The project ID is derived from the root commit SHA of the repository, so it is the **same from any worktree** — parent and child sessions always share the same database.

## Testing

```bash
# Run all tests
bun test tests/

# Run with watch mode
bun test --watch tests/
```

Tests create ephemeral sandbox repos in `/tmp/worktree-enhanced-test-*` and clean them up automatically.

## Portability

This plugin was originally ported and enhanced from [stevenke1981/opencode-worktree-tools](https://github.com/stevenke1981/opencode-worktree-tools). Notable improvements:

- **Global shared state** — Fixes the "empty DB in worktree" bug where a worktree session couldn't see sessions created by the parent session
- **Multi-terminal support** — 15+ terminal emulators across all platforms
- **Two-tier merge detection** — Ancestry check (regular merges) + content diff (squash/rebase merges)
- **Auto-config** — First-run config creation with helpful comments
- **Path traversal protection** — Defensive path resolution for all file operations
- **No external dependencies** beyond opencode plugin API and jsonc-parser

## License

MIT
