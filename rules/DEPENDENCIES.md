# Dependency Rules

Rules for adding, updating, and removing dependencies in pi-shazam.

## Package Manager

- **npm** is the package manager. Do not use yarn, pnpm, or bun.
- **Always install with `--legacy-peer-deps`**: `npm install --legacy-peer-deps`. This is required because tree-sitter grammar packages have conflicting peer dependency ranges that npm cannot resolve normally.
- **Lock file**: `package-lock.json` is committed. Do not delete it or regenerate it without reason.
- **Engine constraint**: Node.js >= 18 (declared in `package.json` `engines` field).

## Runtime Dependencies

These are the production dependencies shipped with the extension.

### tree-sitter ecosystem

| Package | Purpose | Pinning |
|---------|---------|---------|
| `tree-sitter` | Core parser (Node.js binding) | Pinned to 0.22.4 via `overrides` in package.json |
| `tree-sitter-typescript` | TypeScript/TSX grammar | Peer dep on tree-sitter |
| `tree-sitter-javascript` | JavaScript grammar | Peer dep on tree-sitter |
| `tree-sitter-python` | Python grammar | Peer dep on tree-sitter |
| `tree-sitter-rust` | Rust grammar | Peer dep on tree-sitter |
| `tree-sitter-go` | Go grammar | Peer dep on tree-sitter |
| `tree-sitter-java` | Java grammar | Peer dep on tree-sitter |
| `tree-sitter-c-sharp` | C# grammar | Peer dep on tree-sitter |

**Critical**: tree-sitter is pinned to 0.22.4 via `overrides` in package.json. This forces npm to install 0.22.4 regardless of what the grammar packages declare in their peer dependencies. Do not change this pin without testing ALL grammars.

**Adding a new grammar**: Add the grammar package, verify it works with tree-sitter 0.22.4, add the extension mapping in `core/treesitter.ts` EXT_TO_LANG map, add tree-sitter queries in `core/treesitter-queries.ts`, add LSP server config in `lsp/servers.ts`.

### LSP client stack

| Package | Purpose |
|---------|---------|
| `vscode-jsonrpc` | JSON-RPC transport for LSP communication (StreamMessageReader/StreamMessageWriter) |
| `vscode-languageserver-protocol` | LSP type definitions (Diagnostic, Location, Position, Range, SymbolKind, etc.) |

These are used in `lsp/client.ts` for communicating with language servers. The project uses the official `createMessageConnection` pattern from `vscode-jsonrpc/node`, not hand-written Content-Length frame parsing.

### Encoding

| Package | Purpose |
|---------|---------|
| `iconv-lite` | UTF-8 / GBK / GB2312 encoding fallback for source file reading |

Used by `core/encoding.ts` adaptive reader. The fast path is UTF-8; GBK and GB2312 are fallbacks that only activate on decode failure.

### Validation

| Package | Purpose |
|---------|---------|
| `@sinclair/typebox` | JSON Schema for Pi tool parameters (ExtensionAPI contract) |
| `zod` | Runtime validation for MCP tool parameters |

Pi tools use TypeBox schemas (required by ExtensionAPI). MCP tools use Zod schemas (required by MCP SDK). Do not cross-use them.

### MCP server

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server implementation for exposing tools to external MCP clients |

Used in `mcp/entry.ts` and `mcp/tools.ts`.

## Dev Dependencies

| Package | Purpose |
|---------|---------|
| `@types/node` | Node.js type definitions |
| `prettier` | Code formatting (tabs, double quotes, trailing commas, 120 width) |
| `typescript` | Type checking and compilation |
| `vitest` | Test runner and benchmark framework |

There is no eslint in this project. Formatting is handled entirely by prettier.

## Dependency Management Rules

### Adding a new dependency

1. **Research alternatives first.** Check if an existing dependency already covers the need. Check npm download count, maintenance status, open issues, and bundle size.
2. **Check size impact.** Run `npm pack --dry-run` before and after adding to see the tarball size delta. Pi extensions are loaded at startup — large dependencies slow boot.
3. **Check license compatibility.** pi-shazam is MIT licensed. All runtime dependencies must be MIT, ISC, Apache-2.0, or BSD.
4. **Run `npm audit --omit=dev`** after adding. Fix any new vulnerabilities before committing.
5. **Run the full test suite.** `npm test` must pass with the new dependency.
6. **Update this file.** Add the dependency to the appropriate table above.

### Updating dependencies

1. **Do not update tree-sitter or its grammars casually.** The 0.22.4 pin exists for a reason — newer versions may break grammar compatibility. Test thoroughly before changing.
2. **Run `npm install --legacy-peer-deps` after any package.json change.** Without this flag, npm will fail on tree-sitter peer dep conflicts.
3. **Run the full CI.** `npm run ci` must pass after any dependency update.
4. **Check for breaking changes** in the dependency's changelog before updating.

### Removing dependencies

1. **Grep for all imports** of the package across the codebase before removing.
2. **Remove from package.json** and run `npm install --legacy-peer-deps` to update the lock file.
3. **Run the full test suite** to catch any missed references.
4. **Update this file** to remove the entry from the appropriate table.

## Publishing

- **npm publish** is done via GitHub Actions (`publish.yml`), triggered by creating a GitHub Release.
- **Do not run `npm publish` manually.** Always use the release workflow to ensure CI passes before publishing.
- The publish workflow runs: `npm ci --legacy-peer-deps` -> typecheck -> test -> build -> `npm publish`.
- `package.json` has `"files"` field controlling what goes into the tarball. Verify `dist/` is included.

## Supply Chain Security

- **Dependabot** is enabled for automated dependency updates.
- **`npm audit --omit=dev`** runs in CI and locally. Audit failures in production dependencies should be fixed promptly.
- **Lock file integrity**: `package-lock.json` is committed and used by `npm ci` in CI. Do not use `npm install` in CI — always `npm ci`.
- **No postinstall scripts**: Verify new dependencies do not run unexpected postinstall scripts. Check `package.json` of new deps.
