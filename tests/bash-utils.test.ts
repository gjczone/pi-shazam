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

	it("splits on pipe separator", () => {
		expect(tokenizeCommand("echo foo | grep bar")).toEqual(["echo", "foo", "grep", "bar"]);
	});

	it("splits on semicolon separator", () => {
		expect(tokenizeCommand("echo foo; ls -la")).toEqual(["echo", "foo", "ls", "-la"]);
	});

	it("splits on && separator", () => {
		expect(tokenizeCommand("make && make install")).toEqual(["make", "make", "install"]);
	});

	it("splits on || separator", () => {
		expect(tokenizeCommand("cmd1 || cmd2")).toEqual(["cmd1", "cmd2"]);
	});

	it("splits mixed separators", () => {
		expect(tokenizeCommand("echo foo | grep bar && echo done; ls")).toEqual([
			"echo", "foo", "grep", "bar", "echo", "done", "ls",
		]);
	});

	it("treats $() as single token", () => {
		expect(tokenizeCommand("echo $(ls -la)")).toEqual(["echo", "$(ls -la)"]);
	});

	it("handles nested $()", () => {
		expect(tokenizeCommand("echo $(echo $(pwd))")).toEqual(["echo", "$(echo $(pwd))"]);
	});

	it("does not split on | inside quotes", () => {
		expect(tokenizeCommand("echo 'hello | world'")).toEqual(["echo", "hello | world"]);
	});

	it("does not split on | inside $()", () => {
		expect(tokenizeCommand("echo $(echo hello | world)")).toEqual(["echo", "$(echo hello | world)"]);
	});

	it("handles pipe with git commit (safety gate scenario)", () => {
		// git commit detection uses argv[0]; this test ensures the safety loop
		// sees "git" in the flat token list even when it's the second command
		expect(tokenizeCommand("echo done && git commit -m 'msg'")).toEqual([
			"echo", "done", "git", "commit", "-m", "msg",
		]);
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
