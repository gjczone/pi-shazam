/**
 * Tests for issue #642: replace regex-based cyclomatic complexity with
 * tree-sitter AST traversal.
 *
 * The core regression: the old regex swept `if|else|for|while|case|catch`
 * plus `&&`, `||`, `?:` across the whole source slice, counting keywords
 * that appear inside comments and string literals. That produced false
 * positives that would break threshold-based alerting (#631 follow-up).
 *
 * These tests assert the AST walker:
 *   1. scores a function whose body contains ONLY comment/string copies of
 *      the keywords as 1 (baseline, no false branches);
 *   2. counts only real branching constructs;
 *   3. applies the else-if rule (plain `else` adds 0, `else if` adds 1).
 *
 * `countCyclomaticComplexity(source, lang, startLine, endLine)` is the
 * unit under test; fixtures pass startLine=1 / endLine=9999 so the entire
 * source is in range and line math is not under test here.
 */
import { describe, it, expect } from "vitest";
import { countCyclomaticComplexity } from "../core/complexity.js";

const FULL_RANGE: [number, number] = [1, 9999];

describe("complexity: comments and strings must not inflate the score", () => {
	it("scores 1 when keyword tokens appear only in comments/strings (TS)", () => {
		const src = `
function stringsOnly() {
	// if else for while case catch && || ?:
	const doc = "if else for while case catch && || ?:";
	/* if (x) { return true; } else { return false; } */
	return doc;
}
`;
		expect(countCyclomaticComplexity(src, "typescript", ...FULL_RANGE)).toBe(1);
	});

	it("does not count a single real if as more than 1 branch (TS)", () => {
		const src = `
function tricky(cond) {
	// TODO: if this branch fails, panic
	const msg = "if you see this, the world ends";
	if (cond) return 1;
	return 0;
}
`;
		// One real if_statement => baseline 1 + 1 = 2.
		expect(countCyclomaticComplexity(src, "typescript", ...FULL_RANGE)).toBe(2);
	});
});

describe("complexity: exact AST counts (TypeScript)", () => {
	it("counts if / else-if / for / && / ternary", () => {
		const src = `
function ctrl(a, b) {
	if (a) {
	} else if (b) {
	} else {
	}
	for (let i = 0; i < a; i++) {}
	const x = a && b ? 1 : 2;
}
`;
		// if(a)=1, else-if(b): else_clause(+1) + nested if(b)(+1)=2,
		// for=1, && =1, ternary=1 => 6 branches => score 7.
		expect(countCyclomaticComplexity(src, "typescript", ...FULL_RANGE)).toBe(7);
	});

	it("counts switch cases and catch clause", () => {
		const src = `
function sw(v) {
	try {
		switch (v) {
			case 1: break;
			case 2: break;
			default: break;
		}
	} catch (e) {
	}
	return 0;
}
`;
		// switch_case x2=2, switch_default=1, catch_clause=1 => 4 => score 5.
		expect(countCyclomaticComplexity(src, "typescript", ...FULL_RANGE)).toBe(5);
	});

	it("counts do/while loops when present", () => {
		const src = `
function loops(n) {
	let i = 0;
	do {
		i++;
	} while (i < n);
	while (n > 0) {
		n--;
	}
	return i;
}
`;
		// do_statement=1 (its `while` condition is folded into the node, not a
		// separate while_statement), while(n>0)=1 => 2 branches => score 3.
		expect(countCyclomaticComplexity(src, "typescript", ...FULL_RANGE)).toBe(3);
	});

	it("plain else adds 0 but else-if adds 1", () => {
		const src = `
function e1(a) {
	if (a) { return 1; } else { return 2; }
}
function e2(a, b) {
	if (a) { return 1; } else if (b) { return 2; } else { return 3; }
}
`;
		// e1: if(a)=1, plain else=0 => 1 branch.
		// e2: if(a)=1, else-if(b): else_clause(+1)+if(b)(+1)=2, plain else=0 => 3 branches.
		// Whole-slice sum (both functions in range): 1 + 3 = 4 branches => score 5.
		expect(countCyclomaticComplexity(src, "typescript", ...FULL_RANGE)).toBe(5);
	});
});

describe("complexity: exact AST counts (cross-language)", () => {
	it("Python: if / elif / else / for / and-or", () => {
		const src = `
def py(x, y, z):
    if x:
        pass
    elif y:
        pass
    else:
        pass
    for i in range(10):
        pass
    val = x and y or z
    return val
`;
		// if=1, elif=1, else=0, for=1, (x and y)=1, (.. or z)=1 => 5 => score 6.
		expect(countCyclomaticComplexity(src, "python", ...FULL_RANGE)).toBe(6);
	});

	it("Go: if / for / switch cases / &&", () => {
		const src = `
package main
func goFn(a int, b int) int {
	if a > b {
	}
	for i := 0; i < a; i++ {
	}
	switch a {
	case 1:
	case 2:
	default:
	}
	return a && b
}
`;
		// if=1, for=1, expression_case x2=2, default_case=1, && =1 => 6 => score 7.
		expect(countCyclomaticComplexity(src, "go", ...FULL_RANGE)).toBe(7);
	});

	it("Rust: if / else-if / for / while / match / &&", () => {
		const src = `
fn rust_fn(a: bool, b: bool) -> i32 {
    if a {
        1
    } else if b {
        2
    } else {
        3
    }
    for i in 0..10 {}
    while a {}
    let x = if a { 1 } else { 0 };
    match a {
        true => 1,
        false => 0,
    }
    a && b
}
`;
		// if(a)=1, else-if(b): else_clause(+1)+if(b)(+1)=2, for=1, while=1,
		// let-if=1, match_arm x2=2, && =1 => 9 => score 10.
		expect(countCyclomaticComplexity(src, "rust", ...FULL_RANGE)).toBe(10);
	});
});

describe("complexity: graceful fallback for unsupported languages", () => {
	it("returns a numeric score (>=1) for a language without an AST query", () => {
		// JSON has no branching grammar and no complexity query -> regex fallback.
		const src = `{"if": "else"}`;
		const score = countCyclomaticComplexity(src, "json", 1, 1);
		expect(score).toBeGreaterThanOrEqual(1);
	});
});
