/**
 * Regression test for issue #544: audit-log redaction order.
 *
 * The MCP audit-log writer in mcp/tools.ts previously called
 * `redact(s.slice(0, N))` -- slicing BEFORE redacting. Because the secret
 * patterns in core/redact.ts are full-match regexes (e.g. `AKIA[0-9A-Z]{16}`),
 * a secret that straddled the truncation boundary was split in half before
 * `redact()` ever saw it, and the partial fragment leaked to disk verbatim.
 *
 * The fix swaps the order to `redact(s).slice(0, N)` -- redact the full
 * string first, then truncate the already-redacted result.
 *
 * Two test layers:
 *  1. Pure-function unit tests of `redact()` -- document the safe pattern.
 *  2. End-to-end regression through the real `withLogging` audit-log write
 *     path in mcp/tools.ts -- this is the test that FAILS against the buggy
 *     slice-then-redact ordering and locks in the fix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { redact } from "../core/redact.js";

/**
 * Build a JSON args string where a secret starts at `targetKeyStart` so it
 * straddles the N-char truncation boundary (starts before N, ends after N).
 */
function buildJsonWithKeyAt(targetKeyStart: number, secret: string): string {
	const prefixJson = JSON.stringify({ tool: "shazam_lookup", input: "" });
	const envelopeOpen = prefixJson.slice(0, -2); // strip trailing "}
	const paddingLen = Math.max(0, targetKeyStart - envelopeOpen.length);
	const padding = "a".repeat(paddingLen);
	const args = { tool: "shazam_lookup", input: padding + secret + "tail" };
	return JSON.stringify(args);
}

describe("MCP audit log redaction order (#544)", () => {
	it("redact-then-slice does not leak partial AWS key across 200-char args boundary", () => {
		const awsKey = "AKIA0123456789ABCDEF"; // 20 chars: AKIA + 16
		const targetKeyStart = 196; // 4 chars before the 200-char boundary
		const json = buildJsonWithKeyAt(targetKeyStart, awsKey);
		expect(json.length).toBeGreaterThan(200);

		const keyStart = json.indexOf("AKIA");
		expect(keyStart).toBe(targetKeyStart);
		// Key straddles the boundary: starts before 200, ends after 200.
		expect(keyStart + awsKey.length).toBeGreaterThan(200);

		// CORRECT order (the fix): redact the full string, then slice.
		const result = redact(json).slice(0, 200);
		expect(result.length).toBeLessThanOrEqual(200);
		expect(result).not.toContain("AKIA");
		expect(result).not.toMatch(/AKIA[0-9A-Z]{1,15}/);
		// Full redaction happened before truncation.
		expect(redact(json)).toContain("[REDACTED]");
	});

	it("redact-then-slice does not leak partial AWS key across 300-char error boundary", () => {
		const awsKey = "AKIA0123456789ABCDEF";
		const errPrefix = "Error: lookup failed for input ";
		const targetKeyStart = 295; // 5 chars before the 300-char boundary
		const paddingLen = Math.max(0, targetKeyStart - errPrefix.length);
		const padding = "e".repeat(paddingLen);
		const err = `${errPrefix}${padding}${awsKey}trailing`;
		expect(err.length).toBeGreaterThan(300);

		const keyStart = err.indexOf("AKIA");
		expect(keyStart).toBe(targetKeyStart);
		expect(keyStart + awsKey.length).toBeGreaterThan(300);

		const result = redact(err).slice(0, 300);
		expect(result.length).toBeLessThanOrEqual(300);
		expect(result).not.toContain("AKIA");
		expect(result).not.toMatch(/AKIA[0-9A-Z]{1,15}/);
		expect(redact(err)).toContain("[REDACTED]");
	});

	it("redact-then-slice does not leak partial GitHub token across 200-char boundary", () => {
		const ghpToken = "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz0123456789"; // 40 chars
		const targetKeyStart = 196;
		const json = buildJsonWithKeyAt(targetKeyStart, ghpToken);
		expect(json.length).toBeGreaterThan(200);

		const keyStart = json.indexOf("ghp_");
		expect(keyStart).toBe(targetKeyStart);
		expect(keyStart + ghpToken.length).toBeGreaterThan(200);

		const result = redact(json).slice(0, 200);
		expect(result.length).toBeLessThanOrEqual(200);
		expect(result).not.toContain("ghp_");
		expect(result).not.toMatch(/ghp_[A-Za-z0-9_]{1,35}/);
		expect(redact(json)).toContain("[REDACTED]");
	});

	it("BUGGY slice-then-redact WOULD leak partial AWS key (documents the bug)", () => {
		const awsKey = "AKIA0123456789ABCDEF";
		const targetKeyStart = 196;
		const json = buildJsonWithKeyAt(targetKeyStart, awsKey);
		expect(json.indexOf("AKIA")).toBe(targetKeyStart);

		// BUGGY order (the old code): slice first, then redact.
		const sliced = json.slice(0, 200);
		const result = redact(sliced);
		// The slice cut the key mid-pattern, leaving a fragment too short for
		// the full-match regex to catch. Partial "AKIA" leaks to the log.
		expect(result).toContain("AKIA");
	});
});

// ---------------------------------------------------------------------------
// End-to-end regression: real withLogging audit-log write path in mcp/tools.ts.
// This is the test that FAILS against the buggy slice-then-redact ordering.
// ---------------------------------------------------------------------------

// Capture fs.appendFile writes so we can inspect the redacted audit-log line.
// vi.hoisted() runs before vi.mock factories are hoisted, so the mock fn is
// initialized when the factory executes.
const { appendFileMock } = vi.hoisted(() => ({
	appendFileMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("node:fs/promises", () => ({
	appendFile: appendFileMock,
	mkdir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../core/audit-log.js", () => ({
	AUDIT_LOG_DIR: "/tmp/pi-shazam-test-audit",
	rotateAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoGraph } from "../core/graph.js";
import { registerAllTools } from "../mcp/tools.js";
import { clearRenameState } from "../hooks/rename-state.js";

interface CapturedHandler {
	(args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

function makeCaptureServer(): { server: McpServer; handlers: Map<string, CapturedHandler> } {
	const handlers = new Map<string, CapturedHandler>();
	const server = {
		registerTool(name: string, _opts: unknown, handler: CapturedHandler) {
			handlers.set(name, handler);
		},
	};
	return { server: server as unknown as McpServer, handlers };
}

const DUMMY_GRAPH = {} as RepoGraph;

/** Flush the fire-and-forget `void logMCP(...)` promises inside withLogging. */
function flushPending(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Parse every captured appendFile payload into a list of log-entry objects. */
function capturedLogEntries(): Array<Record<string, unknown>> {
	const entries: Array<Record<string, unknown>> = [];
	for (const call of appendFileMock.mock.calls) {
		// appendFile(path, data, encoding) -- data is the JSON line + "\n"
		const data = call[1] as string;
		if (typeof data !== "string") continue;
		for (const line of data.split("\n")) {
			if (!line) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				// skip non-JSON lines (should not happen)
			}
		}
	}
	return entries;
}

describe("MCP withLogging audit-log redaction (#544, end-to-end)", () => {
	let handlers: Map<string, CapturedHandler>;

	beforeEach(() => {
		clearRenameState();
		appendFileMock.mockClear();
		const captured = makeCaptureServer();
		handlers = captured.handlers;
		registerAllTools(captured.server, () => DUMMY_GRAPH, ".");
	});

	it("start-event params field redacts the full secret BEFORE 200-char truncation", async () => {
		// Construct a `name` argument whose JSON form is >200 chars and whose
		// AWS key straddles char 200 of JSON.stringify(args). The key is placed
		// early enough that the [REDACTED] placeholder (10 chars) lands fully
		// before the 200-char boundary, so the placeholder survives truncation
		// and we can assert it -- while the original 20-char secret still
		// straddles 200 (starts before, ends after).
		// JSON form: {"name":"<PADDING><SECRET>"} -- envelope prefix is 9 chars.
		const secret = "AKIA0123456789ABCDEF"; // 20 chars: AKIA + 16
		const envelopePrefix = '{"name":"';
		const targetKeyStart = 185; // secret at 185-204, straddles 200; [REDACTED] at 185-194, within 200
		const padding = "x".repeat(targetKeyStart - envelopePrefix.length);
		const name = padding + secret;
		// Sanity: JSON.stringify(args) is >200 chars and the key straddles 200.
		const argsJson = JSON.stringify({ name });
		expect(argsJson.length).toBeGreaterThan(200);
		const keyIdx = argsJson.indexOf("AKIA");
		expect(keyIdx).toBe(targetKeyStart);
		expect(keyIdx).toBeLessThan(200); // secret starts before the boundary
		expect(keyIdx + secret.length).toBeGreaterThan(200); // ...and ends after it

		// Invoke shazam_lookup. The handler will throw on the empty graph, but
		// withLogging has ALREADY fired the start-event log entry (with the
		// params field) before the handler body runs. We swallow the throw.
		try {
			await handlers.get("shazam_lookup")!({ name });
		} catch {
			/* expected -- empty graph, handler throws downstream */
		}
		await flushPending();

		const entries = capturedLogEntries();
		const startEntries = entries.filter((e) => e.event === "start" && e.tool === "shazam_lookup");
		expect(startEntries.length).toBeGreaterThanOrEqual(1);

		const params = startEntries[0].params as string;
		// The buggy ordering (slice-then-redact) would leave a partial "AKIA"
		// fragment because the key is cut mid-pattern at char 200. The fix
		// redacts the full string first, so no "AKIA" substring survives.
		expect(params).not.toContain("AKIA");
		expect(params).not.toMatch(/AKIA[0-9A-Z]{1,15}/);
		// The full secret was replaced with [REDACTED] before truncation.
		expect(params).toContain("[REDACTED]");
		expect(params.length).toBeLessThanOrEqual(200);
	});

	it("end-event error field never contains a partial AKIA fragment", async () => {
		// Drive shazam_lookup with a file-path name inside project root so the
		// handler proceeds to executeFileDetailAsync, which throws on the empty
		// graph. withLogging's catch logs `redact(String(err).slice(0, 300))`
		// (buggy) or `redact(String(err)).slice(0, 300)` (fixed) as the `error`
		// field. We assert that whatever is logged never contains a partial
		// AKIA pattern. (The authoritative 300-char ordering assertion for a
		// controlled straddling payload lives in the pure-function tests above,
		// since we cannot inject a synthetic error message into withLogging.)
		const name = "core/redact.ts"; // real path inside root, exists on disk
		try {
			await handlers.get("shazam_lookup")!({ name });
		} catch {
			/* expected -- empty graph, handler throws downstream */
		}
		await flushPending();

		const entries = capturedLogEntries();
		const endEntries = entries.filter((e) => e.event === "end" && e.tool === "shazam_lookup");
		for (const e of endEntries) {
			const errField = (e.error as string) ?? "";
			expect(errField).not.toMatch(/AKIA[0-9A-Z]{1,15}/);
		}
	});
});
