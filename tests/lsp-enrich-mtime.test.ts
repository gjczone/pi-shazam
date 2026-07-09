import { describe, it, expect } from "vitest";
import type { LspEnrichContext } from "../tools/lsp_enrich.js";

class MockEnrichContext implements LspEnrichContext {
	openedFiles: { language: string; filePath: string; mtime?: number }[] = [];

	hasServerForLanguage(): boolean {
		return false;
	}

	getServerForFile(): null {
		return null;
	}

	getActiveServers(): { language: string; client: unknown; workspaceRoot: string }[] {
		return [];
	}

	trackOpenedFile(language: string, filePath: string, mtime?: number): void {
		this.openedFiles.push({ language, filePath, mtime });
	}
}

describe("LspEnrichContext.trackOpenedFile mtime param", () => {
	it("accepts a 3-arg call with mtime and records it", () => {
		const ctx = new MockEnrichContext();
		ctx.trackOpenedFile("ts", "f.ts", 12345);
		expect(ctx.openedFiles).toHaveLength(1);
		expect(ctx.openedFiles[0]).toEqual({ language: "ts", filePath: "f.ts", mtime: 12345 });
	});

	it("still accepts the legacy 2-arg call (backward compatible)", () => {
		const ctx = new MockEnrichContext();
		ctx.trackOpenedFile("ts", "f.ts");
		expect(ctx.openedFiles).toHaveLength(1);
		expect(ctx.openedFiles[0]).toEqual({ language: "ts", filePath: "f.ts", mtime: undefined });
	});
});
