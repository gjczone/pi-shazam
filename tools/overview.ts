/**
 * pi-shazam tools/overview -- Pi tool registration for shazam_overview.
 *
 * The overview construction logic (text + typed JSON result, section
 * builders, Overview* interfaces) now lives in core/overview.ts (issue #716)
 * so the tools layer no longer leaks into hooks/. This file keeps only the
 * Pi tool registration and re-exports the core symbols for test compatibility.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import { createTool } from "./_factory.js";
import { dispatchOverview } from "./_dispatchers.js";

export function registerOverview(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_overview",
		label: "Project Overview",
		description: `\
		When you first enter a project or return after changes - use this to
		understand the codebase before reading a single file. Returns: module
		dependency map, top-10 highest-PageRank files (the "spine"), key
		dependencies, recent git changes, entry points, reading order, HTTP
		route inventory, and complexity hotspots ranked by blast radius.
		Supports --filter to locate files by keyword.

		Output: plain text summary by default. Pass { json: true } for
		structured output with file lists and PageRank scores.`,
		params: Type.Object({
			filter: Type.Optional(Type.String()),
		}),
		execute(graph, params) {
			const projectRoot = (params.project as string) || ".";
			return dispatchOverview(graph, params, projectRoot);
		},
	});
}

// -- Re-export core symbols for test compatibility ------------------------
// tools/overview.ts historically exposed these; core/overview.ts is now the
// source of truth. Tests import them from ../tools/overview.js unchanged.
export {
	executeOverview,
	executeOverviewJson,
	buildOverviewResult,
	_detectEntryPoints,
	buildKeyDependenciesSection,
	buildRecentChangesSection,
	_buildDataStructuresSection,
	_computeHotspots,
} from "../core/overview.js";

export type {
	OverviewTopFile,
	OverviewHotspot,
	OverviewResult,
	OverviewModuleDensity,
	OverviewEntryPoint,
	OverviewFileHotspot,
	OverviewParserWarning,
	OverviewModuleNode,
} from "../core/overview.js";
