/**
 * _shared.ts — single source of truth for tool names and shared suggestion text
 * used across pi-shazam hooks (before-start, shazam-guide, failure-recovery, etc.).
 *
 * When tools are added, renamed, or removed, update this file first,
 * then rebuild via `npm run build` and re-test.
 */

// ── Tool name constants ──

export const SHZ_OVERVIEW = "shazam_overview" as const;
export const SHZ_LOOKUP = "shazam_lookup" as const;
export const SHZ_IMPACT = "shazam_impact" as const;
export const SHZ_VERIFY = "shazam_verify" as const;
export const SHZ_CHANGES = "shazam_changes" as const;
export const SHZ_FORMAT = "shazam_format" as const;
export const SHZ_RENAME_SYMBOL = "shazam_rename_symbol" as const;

export const ALL_SHZ_TOOLS = [
	SHZ_OVERVIEW,
	SHZ_LOOKUP,
	SHZ_IMPACT,
	SHZ_VERIFY,
	SHZ_CHANGES,
	SHZ_FORMAT,
	SHZ_RENAME_SYMBOL,
] as const;

export const SHAZAM_TOOL_COUNT = ALL_SHZ_TOOLS.length;

// ── Removed tools (documented for reference) ──

/** shazam_find_tests was removed — use Bash `find` for test discovery. */
export const REMOVED_FIND_TESTS = "shazam_find_tests is not available — use Bash `find` for test discovery.";
/** shazam_safe_delete was removed — use lookup first, then rm manually. */
export const REMOVED_SAFE_DELETE =
	"shazam_safe_delete is not available — before rm, use shazam_lookup to confirm zero external refs.";

// ── Shared suggestion text ──

export const SUGGESTIONS = {
	/** before-start.ts + shazam-guide.ts + failure-recovery.ts */
	verifyAfterEdit: "Run `shazam_verify` after edits to catch errors",
	/** before-start.ts + shazam-guide.ts */
	impactBeforeEdit: "Before changing a shared/exported symbol: `shazam_impact --symbol <name>`",
	/** before-start.ts + failure-recovery.ts */
	overviewForStructure: "`shazam_overview` to understand project structure",
	/** before-start.ts + failure-recovery.ts */
	lookupBeforeEdit: "`shazam_lookup --file <path>` before editing any file",
	/** shazam-guide.ts */
	formatSuggestion: "run shazam_format to auto-format",
	/** shazam-guide.ts */
	impactMultipleFiles:
		"shazam_impact checks blast radius across all affected files — consider running it before continuing",
	/** failure-recovery.ts */
	reorientOverview: "1. Run `shazam_overview` to reorient yourself",
	/** failure-recovery.ts */
	typeErrorVerify: "The error looks like a type or syntax error. Run shazam_verify to inspect it.",
} as const;
