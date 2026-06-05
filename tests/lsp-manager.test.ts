import { describe, it, expect, beforeEach } from "vitest";
import { LspManager } from "../lsp/manager.js";

describe("lsp/manager", () => {
	describe("LspManager constructor", () => {
		it("should create an LspManager", () => {
			const manager = new LspManager("/test/project");
			expect(manager).toBeDefined();
		});

		it("should initialize with empty server list", () => {
			const manager = new LspManager("/test/project");
			expect(manager.getActiveServers()).toEqual([]);
		});
	});

	describe("LspManager lifecycle", () => {
		let manager: LspManager;

		beforeEach(() => {
			manager = new LspManager("/test/project");
		});

		it("should expose getActiveServers method", () => {
			expect(typeof manager.getActiveServers).toBe("function");
		});

		it("should expose shutdown method", () => {
			expect(typeof manager.shutdown).toBe("function");
		});

		it("should expose getServerForFile method", () => {
			expect(typeof manager.getServerForFile).toBe("function");
		});

		it("should expose detectLanguages method", () => {
			expect(typeof manager.detectLanguages).toBe("function");
		});
	});

	describe("getServerForFile", () => {
		it("should return null for unsupported file types", () => {
			const manager = new LspManager("/test/project");
			// Manager starts with no servers, and .rb is not in our 6-language map
			expect(manager.getServerForFile("/test/script.rb")).toBeNull();
		});
	});
});
