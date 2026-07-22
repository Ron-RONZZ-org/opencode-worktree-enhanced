# AGENTS-tests.md — Test Suite Instructions

## Summary
Test suite for opencode-worktree-enhanced using `bun:test`. Tests validate branch names, worktree cleanliness, branch merge status, git helper behavior, and end-to-end validation combinations.

## Test File Structure

All tests live in `tests/worktree.test.ts`. Each `describe` block creates its own sandbox repo in `SANDBOX` (a timestamped directory under `/tmp`).

### Test Helpers (in tests/worktree.test.ts)

| Helper | Purpose |
|--------|---------|
| `createGitRepo(path, branch)` | Init git repo with a commit on the given branch |
| `createCommitOnBranch(path, branch, msg)` | Create a commit on a branch (creating it if needed) |
| `mergeBranch(path, target, source)` | Regular merge with `--no-edit` |
| `squashMergeBranch(path, target, source)` | Squash merge — creates single commit, source commits remain orphaned |

## Constraints

- **All test repos must be cleaned up** in `afterAll` via `fs.rmSync(path, { recursive: true, force: true })`.
- **Tests use `execSync` for git setup** (sync, simple) and **async calls** for testing the plugin APIs.
- **Do not test directly via the opencode plugin tool interface** — test the exported functions from `src/` modules. The tools in `index.ts` are thin wrappers around those functions.
- **Test both `ok: true` and `ok: false` paths** for every function that returns `Result<T, E>`.

## Existing Test Suites

| describe block | What it tests |
|---------------|--------------|
| `validateBranchName` | 10+ cases: valid names, empty, leading dash, shell metachars, git ref chars, length limit, `.lock` suffix |
| `validateWorktreeClean` | Clean repo, dirty (modified file), dirty (untracked), non-existent path |
| `validateBranchMerged` | Merged branch, unmerged branch, non-existent branch, non-existent base, non-existent repo |
| `validateBranchMerged (squash merge)` | Squash-merge detection via content diff fallback |
| `git helper` | `git()` success, failure, non-existent cwd |
| `removeWorktree` | Valid worktree removal, non-existent path |
| `end-to-end: clean + merged` | Both validations pass |
| `end-to-end: dirty + merged` | Clean fails, merged passes |
| `end-to-end: clean + unmerged` | Clean passes, merged fails |
| `getSessionByBranch` | Session CRUD: insert, find by branch, find by path, duplicates, empty name, remove |
| `deferred worktree deletion flow` | Full flow: create worktree → mark pending → cleanup actually removes |
| `cross-session worktreeDelete scenario` | Simulates finding a worktree by branch from a different session and cleaning it up |

## Key Design Invariant

**`worktreeDelete` always requires a `branch` parameter.** There is no path-based fallback or "current session" detection. Session lookup always uses `getSessionByBranch()`. This is intentional — it eliminates ambiguity about which worktree to delete when calling from a parent session. To discover active branches, call `worktreeList` first.
