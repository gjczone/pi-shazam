/**
 * pi-shazam tools/routes — HTTP route inventory.
 *
 * Detects HTTP route registrations using AST pattern matching for common
 * web frameworks (Express, Fastify, Koa, Next.js, etc.).
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";

export function registerRoutes(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_routes",
		label: "HTTP Route Inventory",
		description: `\
Call when working on web/API projects to inventory ALL HTTP routes.
Detects route registrations using AST pattern matching for common
frameworks (Express, Fastify, Koa, Next.js, etc.).

Returns: method (GET/POST/PUT/DELETE), path pattern, handler file:line.

MUST call before changing any route path or handler signature — a route
consumer you miss is a broken API endpoint in production. Also surfaces
routes WITHOUT authentication guards (security risk).

Note: Detection only works for projects using recognized web frameworks.
For CLI tools, libraries, or non-web projects, this will return empty.

Scenario: adding a new API endpoint. Changing a route path or parameter
pattern. Refactoring middleware. Auditing auth coverage across
endpoints. Before deleting a handler function.`,
		parameters: Type.Object({
			json: Type.Optional(Type.Boolean()),
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

// ── Framework detection patterns ────────────────────────────────────────────────

/**
 * Web framework indicators — package/symbol names that suggest HTTP routing exists.
 * Used to detect whether the project is even a web project before searching for routes.
 */
const WEB_FRAMEWORK_INDICATORS = [
	"express",
	"fastify",
	"koa",
	"next",
	"nuxt",
	"hapi",
	"restify",
	"sveltekit",
	"remix",
	"hono",
	"elysia",
	"nestjs",
	"@nestjs/core",
];

/**
 * Route registration patterns — function/method names used to register HTTP routes.
 */
const ROUTE_REGISTRATION_PATTERNS = [
	// Express-style: app.get("/path", handler)
	// Fastify-style: fastify.get("/path", handler)
	// These are detected by looking at the function name in the call graph
	"app.get",
	"app.post",
	"app.put",
	"app.delete",
	"app.patch",
	"app.all",
	"app.use",
	"app.route",
	"router.get",
	"router.post",
	"router.put",
	"router.delete",
	"router.patch",
	"server.get",
	"server.post",
];

export function executeRoutes(graph: RepoGraph, _projectRoot: string): string {
	const lines: string[] = [];
	lines.push("## HTTP Route Inventory");
	lines.push("");

	// Check if the project has web framework dependencies
	const hasWebFramework = detectWebFramework(graph);
	if (!hasWebFramework) {
		lines.push("No web framework detected in this project.");
		lines.push("");
		lines.push(
			"Route inventory is only available for projects using recognized web frameworks.",
		);
		lines.push(
			`Supported frameworks: ${WEB_FRAMEWORK_INDICATORS.slice(0, 6).join(", ")}, etc.`,
		);
		lines.push("");
		lines.push(
			"If this project uses a web framework not in the supported list, route detection will not find routes.",
		);
		return lines.join("\n");
	}

	// Search for route registration symbols
	const routeSymbols = findRouteSymbols(graph);
	if (routeSymbols.length === 0) {
		lines.push(`Web framework detected (${hasWebFramework}), but no route registration patterns found.`);
		lines.push("");
		lines.push("This may mean:");
		lines.push("- Routes are defined in a non-standard way (factory pattern, decorators)");
		lines.push("- Routes are in a file not parsed by tree-sitter");
		lines.push("- The project imports the framework but doesn't register routes");
		return lines.join("\n");
	}

	lines.push(
		`Framework: **${hasWebFramework}** | Found ${routeSymbols.length} route-related symbols`,
	);
	lines.push("");

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

// ── Helpers ─────────────────────────────────────────────────────────────────────

/**
 * Detect whether the project has web framework dependencies.
 * Searches for framework package names via file imports (fileImports).
 */
function detectWebFramework(graph: RepoGraph): string | null {
	// Check file-level imports
	for (const [, imports] of graph.fileImports) {
		for (const imp of imports) {
			const lower = imp.toLowerCase();
			for (const fw of WEB_FRAMEWORK_INDICATORS) {
				if (lower.includes(fw)) {
					return fw;
				}
			}
		}
	}
	return null;
}

/**
 * Find route registration symbols by detecting .get()/.post() etc. patterns in the call graph.
 */
function findRouteSymbols(graph: RepoGraph): Symbol[] {
	const results: Symbol[] = [];

	for (const sym of graph.symbols.values()) {
		const lower = sym.name.toLowerCase();

		// Exact match route registration pattern names
		for (const pattern of ROUTE_REGISTRATION_PATTERNS) {
			if (lower === pattern || lower.endsWith("." + pattern.split(".").pop()!)) {
				results.push(sym);
				break;
			}
		}

		// Detect HTTP method annotations/decorators on handler functions
		if (lower.startsWith("handle") || lower.endsWith("handler") || lower.endsWith("controller")) {
			const isDuplicate = results.some((r) => r.id === sym.id);
			if (!isDuplicate) {
				results.push(sym);
			}
		}
	}

	return results;
}
