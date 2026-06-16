import { describe, it, expect } from "vitest";
import { tokenizeCommand, extractCommandFromEvent } from "../hooks/_bash-utils.js";

describe("tokenizeCommand", () => {
	it("splits simple argv", () => {
		expect(tokenizeCommand("git commit -m 'hello world'")).toEqual(["git", "commit", "-m", "hello world"]);
	});

	it("handles double-quoted escapes", () => {
		expect(tokenizeCommand('echo "hello\\"world"')).toEqual(["echo", 'hello"world']);
	});

	it("handles bash single-quote escape pattern", () => {
		// The full bash idiom: 'it'\''s' → it's
		// In JS string: "'it'\\''s'" (the \\\\ becomes \, and the pattern is '\')
		expect(tokenizeCommand("'it'\\''s'")).toEqual(["it's"]);
	});

	it("returns empty array for empty input", () => {
		expect(tokenizeCommand("")).toEqual([]);
		expect(tokenizeCommand("   ")).toEqual([]);
	});

	it("handles combined flags", () => {
		expect(tokenizeCommand("git commit -nm 'msg'")).toEqual(["git", "commit", "-nm", "msg"]);
	});

	it("handles unquoted backslash escapes", () => {
		expect(tokenizeCommand("echo hello\\ world")).toEqual(["echo", "hello world"]);
	});

	it("handles single-quoted strings with spaces", () => {
		expect(tokenizeCommand("echo 'hello   world'")).toEqual(["echo", "hello   world"]);
	});
});

describe("extractCommandFromEvent", () => {
	it("returns command from valid event", () => {
		expect(extractCommandFromEvent({ input: { command: "ls" } })).toBe("ls");
	});

	it("returns empty for non-object input", () => {
		expect(extractCommandFromEvent({ input: "ls" })).toBe("");
		expect(extractCommandFromEvent({})).toBe("");
		expect(extractCommandFromEvent(null)).toBe("");
	});

	it("returns empty for missing command", () => {
		expect(extractCommandFromEvent({ input: { other: "x" } })).toBe("");
	});

	it("returns empty for undefined", () => {
		expect(extractCommandFromEvent(undefined)).toBe("");
	});

	it("returns empty for non-string command", () => {
		expect(extractCommandFromEvent({ input: { command: 123 } })).toBe("");
	});
});
