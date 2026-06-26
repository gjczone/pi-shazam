# TESTING.md — pi-shazam Testing Rules

## Framework

- **Runner**: vitest 4.1.8
- **Config**: `vitest.config.ts` (project root)
- **Setup**: `vitest.setup.ts` — suppresses `ERR_STREAM_DESTROYED` errors from `vscode-jsonrpc` stream teardown. These are pre-existing noise from LSP client lifecycle, not real failures.
- **Run**: `npm test` (executes `vitest run`, single pass, no watch mode)
- **No coverage requirements** — focus on behavior verification, not line coverage.

## File Naming and Location

- All test files live in `tests/` directory.
- Pattern: `tests/<module-or-feature>.test.ts`
- Examples: `tests/encoding.test.ts`, `tests/git-hooks-toctou.test.ts`, `tests/filter.test.ts`
- One test file per module or distinct feature area. Split when a file exceeds ~200 lines.

## Structure

### AAA Pattern (Arrange-Act-Assert)

Every `it()` block follows:

```ts
it("describes the expected behavior", () => {
  // Arrange — set up inputs, mocks, fixtures
  const input = buildFixture();

  // Act — call the function under test
  const result = functionUnderTest(input);

  // Assert — verify outcome
  expect(result).toEqual(expected);
});
```

### describe/it Hierarchy

```ts
describe("shazam_overview", () => {
  describe("when project has mixed file types", () => {
    it("returns files sorted by PageRank", () => { ... });
    it("excludes node_modules from results", () => { ... });
  });

  describe("edge cases", () => {
    it("handles empty project gracefully", () => { ... });
  });
});
```

- Top-level `describe` = module or tool name.
- Nested `describe` = scenario or input category.
- `it` = one specific behavior.

## Shared Setup

Use `beforeAll` for expensive operations that multiple tests in a file share:

```ts
let overview: OverviewResult;

beforeAll(async () => {
  const { scanProject } = await import("../core/scanner.js");
  overview = await scanProject(".");
}, 60_000); // 60s timeout for full project scan
```

- Project scan and graph build are slow — do them once per `describe` block, not per `it`.
- Set explicit timeout on `beforeAll` when it triggers scanProject or LSP startup.
- Use `beforeEach` only for lightweight resets (clearing caches, resetting state).

## Dynamic Imports

Tool modules register side effects on import (they call `createTool`). To avoid registration side effects during testing, use dynamic imports:

```ts
it("returns definitions for a known symbol", async () => {
  const { registerDefinitions } = await import("../tools/definitions.js");
  // ... test the tool's execute function
});
```

- Always use `await import("../tools/xxx.js")` — never static `import` for tool modules.
- Core modules (`core/graph.ts`, `core/scanner.ts`, `core/encoding.ts`) can use static imports since they have no registration side effects.

## Mocking

### Module Mocks

```ts
vi.mock("../lsp/client.js", () => ({
  LspClient: vi.fn().mockImplementation(() => ({
    getDefinitions: vi.fn().mockResolvedValue([]),
    dispose: vi.fn(),
  })),
}));
```

### Hoisted State

When mock factory functions need variables that survive hoisting, use `vi.hoisted()`:

```ts
const { mockState } = vi.hoisted(() => {
  let mockState: string[] = [];
  return { mockState };
});

vi.mock("../core/cache.js", () => ({
  getCached: vi.fn().mockImplementation(() => mockState),
  setCached: vi.fn().mockImplementation((data: string[]) => {
    mockState.length = 0;
    mockState.push(...data);
  }),
}));
```

- Use `vi.hoisted()` when mock factories reference mutable state.
- Use `vi.mock()` for module-level mocking.
- Use `vi.spyOn()` for intercepting specific methods without replacing the whole module.
- Always call `vi.restoreAllMocks()` in `afterEach` when using spies.

## Self-Hosting

The project uses its own codebase as the primary test fixture:

```ts
const overview = await scanProject(".");
```

- This works because pi-shazam is a valid TypeScript project with tree-sitter grammars, LSP configs, and a dependency graph.
- Tests that scan the project itself are inherently integration tests — they verify the full pipeline.
- When testing graph algorithms, the self-hosted scan provides a realistic node count (~100-200 symbols).

## Synthetic Projects

For benchmarks and boundary tests, generate synthetic TypeScript projects in temp directories:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "shazam-bench-"));
  // Generate 100 .ts files with imports between them
  for (let i = 0; i < 100; i++) {
    writeFileSync(join(tmpDir, `mod${i}.ts`), generateModule(i));
  }
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});
```

## Filesystem Hygiene

- Use `mkdtempSync(join(tmpdir(), "shazam-..."))` for temporary directories.
- Clean up in `afterAll` with `rmSync(dir, { recursive: true, force: true })`.
- Never write to the project root during tests.
- Never leave orphan temp directories — if a test crashes, the OS cleans `/tmp` periodically.

## MCP Integration Tests

Validate the content envelope format expected by MCP clients:

```ts
const result = await mcpServer.callTool("shazam_overview", {});
expect(result).toMatchObject({
  content: [
    {
      type: "text",
      text: expect.stringContaining("## shazam_overview"),
    },
  ],
});
```

- MCP tools return `{ content: [{ type: "text", text: string }] }`.
- Pi tools return `{ text: string }` directly.
- Both formats must contain the same logical content — test parity with `definitions-parity.test.ts`.

## Benchmark Thresholds

Hard performance limits — a test that exceeds these is a regression:

| Operation | Threshold | Fixture |
|---|---|---|
| `scanProject` 100 files | < 30s | Synthetic TS project in temp dir |
| `PageRank` 1000 nodes | < 10s | Generated dependency graph |
| `buildDependencyGraph` | < 5s | Self-hosted scan ("`.`") |

- Set explicit timeouts on benchmark `it()` blocks: `it("...", () => { ... }, 30_000)`.
- Use `console.time`/`console.timeEnd` for ad-hoc profiling during development, remove before committing.
- Benchmark tests are tagged with "performance" in the test name for selective runs.

## Test Categories

Tag tests by category in the `describe` or `it` name for selective execution:

| Category | Scope | Example |
|---|---|---|
| **smoke** | Full pipeline end-to-end | `scanProject(".") → overview → verify output` |
| **integration** | Cross-layer interaction | `tool calls core + LSP, verifies combined result` |
| **unit** | Single module, isolated | `encodeFile() with UTF-8 input` |
| **edge-case** | Boundary conditions | `empty file`, `MAX_FILES limit`, `binary file` |
| **security** | Path traversal, redaction | `../etc/passwd` rejection, secret masking |
| **performance** | Benchmarks | `scanProject 100 files < 30s` |
| **LSP** | Server communication | `initialize → didOpen → definitions → shutdown` |
| **parity** | Pi/MCP sync | `Pi tool and MCP tool return equivalent content` |

Run a specific category: `npx vitest run -t "smoke"` or filter by filename pattern.

## Common Pitfalls

1. **Stale project scan**: If `beforeAll` scans ".", subsequent mutations to the filesystem during the test run won't be reflected. Use temp dirs for mutable fixtures.
2. **LSP server not shutting down**: Always call `dispose()` or `shutdown()` in `afterAll` for LSP tests. Lingering server processes cause test hangs.
3. **Mock import order**: `vi.mock()` must be called before the module is imported. With dynamic imports, ensure `vi.mock()` is at the top level of the file.
4. **ERR_STREAM_DESTROYED**: This error from `vscode-jsonrpc` is suppressed in `vitest.setup.ts`. If you see it in test output, the suppression may have been removed or the error source changed.
5. **Timeout mismatches**: Default vitest timeout is 5s. Scanning the project or starting LSP servers needs 30-60s. Set explicit timeouts.
