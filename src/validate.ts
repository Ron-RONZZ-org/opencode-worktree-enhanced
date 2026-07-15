/**
 * Branch name validation for opencode-worktree-enhanced.
 * Blocks invalid git refs and shell metacharacters.
 */

/**
 * Characters blocked in branch names:
 * - Control characters (0x00-0x1f, 0x7f)
 * - Git ref special chars: ~ ^ : ? * [ ] \\
 * - Shell metacharacters: ; & | ` $ ( )
 * - Leading/trailing dot, leading dash, .lock suffix
 * - Consecutive dots, @{, //
 */
const INVALID_CHARS_RE = /[~^:?*[\]\\;&|`$()\x00-\x1f\x7f]/

/**
 * Validate a git branch name.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateBranchName(name: string): string | null {
	if (!name || name.length === 0) {
		return "Branch name cannot be empty"
	}
	if (name.length > 255) {
		return "Branch name too long (max 255 characters)"
	}
	if (name.startsWith("-")) {
		return "Branch name cannot start with '-' (prevents option injection)"
	}
	if (name.startsWith("/") || name.endsWith("/")) {
		return "Branch name cannot start or end with '/'"
	}
	if (name.startsWith(".") || name.endsWith(".")) {
		return "Branch name cannot start or end with '.'"
	}
	if (name.endsWith(".lock")) {
		return "Branch name cannot end with '.lock'"
	}
	if (name.includes("..")) {
		return "Branch name cannot contain '..'"
	}
	if (name.includes("//")) {
		return "Branch name cannot contain '//'"
	}
	if (name.includes("@{")) {
		return "Branch name cannot contain '@{' (git reflog syntax)"
	}
	if (INVALID_CHARS_RE.test(name)) {
		return "Branch name contains invalid characters"
	}
	return null
}
