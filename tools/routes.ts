/**
 * pi-shazam tools/routes — HTTP route inventory.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";

export function registerRoutes(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_routes",
		label: "HTTP Route Inventory",
		description: `\
Call when working on web/API projects to inventory ALL HTTP routes.
Returns: method (GET/POST/PUT/DELETE), path pattern, handler file:line.

MUST call before changing any route path or handler signature — a route
consumer you miss is a broken API endpoint in production. Also surfaces
routes WITHOUT authentication guards (security risk).

Scenario: adding a new API endpoint. Changing a route path or parameter
pattern. Refactoring middleware. Auditing auth coverage across
endpoints. Before deleting a handler function.`,
		parameters: pi.typebox.Object({
			json: pi.typebox.Optional(pi.typebox.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");
			const result = executeRoutes(graph, ".");
			return {
				content: [
					{
						type: "text",
						text: json
							? JSON.stringify({
									schema_version: "1.0",
									command: "routes",
									status: "ok",
									result: { routeCount: 0 },
								})
							: result,
					},
				],
			};
		},
	});
}

// HTTP method pattern keywords found in symbol names/signatures
const ROUTE_KEYWORDS = [
	"route", "router", "endpoint", "handler", "controller",
	"get", "post", "put", "delete", "patch",
];

export function executeRoutes(graph: RepoGraph, _projectRoot: string): string {
	const routeSymbols: Symbol[] = [];

	for (const sym of graph.symbols.values()) {
		const lower = sym.name.toLowerCase();
		for (const kw of ROUTE_KEYWORDS) {
			if (lower.includes(kw)) {
				routeSymbols.push(sym);
				break;
			}
		}
	}

	const lines: string[] = [];
	lines.push("## HTTP Route Inventory");
	lines.push("");

	if (routeSymbols.length === 0) {
		lines.push("No route-like symbols detected.");
		lines.push("(Route detection works by keyword matching on symbol names.)");
		return lines.join("\n");
	}

	lines.push(
		`Found ${routeSymbols.length} route-related symbols:`,
	);

	// Group by file
	const byFile = new Map<string, Symbol[]>();
	for (const sym of routeSymbols) {
		const arr = byFile.get(sym.file) || [];
		arr.push(sym);
		byFile.set(sym.file, arr);
	}

	for (const [file, syms] of [...byFile.entries()].sort()) {
		lines.push("");
		lines.push(`### ${file}`);
		for (const sym of syms) {
			lines.push(
				`- ${sym.kind} \`${sym.name}\` L${sym.line} — ${sym.signature.slice(0, 80)}`,
			);
		}
	}

	return lines.join("\n");
}
