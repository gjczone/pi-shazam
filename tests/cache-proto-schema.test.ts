/**
 * Schema-mirror consistency test for the V3 ProtoBuf cache (issue #647).
 *
 * `core/graph.proto` is the canonical source of truth for the V3 wire
 * format. `core/proto-schema.ts` mirrors it as inline JSON so the
 * runtime can use `protobufjs` without a code-generation step. If the
 * two drift (someone adds a field to one but not the other) the cache
 * silently writes/reads inconsistent data, which only surfaces when an
 * older or newer pi-shazam tries to load the file. This test parses
 * `core/graph.proto` and asserts the parsed field set matches what
 * protobufjs actually loaded from the JSON mirror.
 *
 * Scope: only the three messages used by the V3 cache (EdgeColumn,
 * FileEdgeColumn, GraphPayload). Field name + field id + type +
 * repeated flag are checked in both directions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getGraphPayloadType,
	getEdgeColumnType,
	getFileEdgeColumnType,
	_resetProtoSchemaCache,
} from "../core/proto-schema.js";

interface ParsedField {
	rule: "repeated" | null;
	type: string;
	id: number;
}

type ParsedProto = Record<string, Record<string, ParsedField>>;

/**
 * Lightweight proto3 parser. The on-disk `graph.proto` uses only
 * `<rule> <type> <name> = <id>;` field syntax with no maps, no oneof,
 * no options, and no nested declarations; a regex-based parser is
 * sufficient to recover the field set we care about.
 */
function parseProtoFile(text: string): ParsedProto {
	const result: ParsedProto = {};
	const messageRegex = /message\s+(\w+)\s*\{([\s\S]*?)\}/g;
	let msgMatch: RegExpExecArray | null;
	while ((msgMatch = messageRegex.exec(text)) !== null) {
		const msgName = msgMatch[1]!;
		const body = msgMatch[2]!;
		const fields: Record<string, ParsedField> = {};
		const fieldRegex = /(repeated\s+)?([\w.]+)\s+(\w+)\s*=\s*(\d+)\s*;/g;
		let fMatch: RegExpExecArray | null;
		while ((fMatch = fieldRegex.exec(body)) !== null) {
			const rule = fMatch[1] ? "repeated" : null;
			const type = fMatch[2]!;
			const fname = fMatch[3]!;
			const id = parseInt(fMatch[4]!, 10);
			fields[fname] = { rule, type, id };
		}
		result[msgName] = fields;
	}
	return result;
}

/**
 * Resolve the absolute path to `core/graph.proto` from the test
 * runner's working directory. `vitest` runs from the project root
 * but other runners (e.g. the dist smoke test) may use a different
 * cwd; try a few candidates before failing.
 */
function findProtoFile(): string {
	const candidates = [
		join(process.cwd(), "core", "graph.proto"),
		join(dirname(fileURLToPath(import.meta.url)), "..", "core", "graph.proto"),
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	throw new Error(`Cannot locate core/graph.proto from cwd=${process.cwd()}; tried ${candidates.join(", ")}`);
}

describe("Cache V3 proto schema mirror consistency (issue #647)", () => {
	const messagesToCheck = [
		{ name: "EdgeColumn", getType: getEdgeColumnType },
		{ name: "FileEdgeColumn", getType: getFileEdgeColumnType },
		{ name: "GraphPayload", getType: getGraphPayloadType },
	] as const;

	it("mirrors field set between core/graph.proto and the JSON schema in proto-schema.ts", () => {
		_resetProtoSchemaCache();
		const parsed = parseProtoFile(readFileSync(findProtoFile(), "utf-8"));

		for (const { name, getType } of messagesToCheck) {
			const parsedFields = parsed[name];
			expect(parsedFields, `Message ${name} is missing in graph.proto`).toBeDefined();

			const liveType = getType();
			const liveFieldNames = Object.keys(liveType.fields);
			const parsedFieldNames = Object.keys(parsedFields!);

			// 1. Same set of field names. Catches "added to one, not the other".
			expect(
				new Set(liveFieldNames),
				`${name} field names diverge between graph.proto (${parsedFieldNames.join(",")}) and JSON mirror (${liveFieldNames.join(",")})`,
			).toEqual(new Set(parsedFieldNames));

			// 2. For each field, the id / type / repeated flag must match.
			//    For nested message fields, compare by the resolved message
			//    name (e.g. `EdgeColumn edges = 2` -> "EdgeColumn"), not the
			//    protobufjs `Type` object identity.
			for (const fname of parsedFieldNames) {
				const p = parsedFields![fname]!;
				const l = liveType.fields[fname]!;
				expect(p.id, `${name}.${fname} id mismatch`).toBe(l.id);
				const liveTypeName = l.resolvedType ? l.resolvedType.name : l.type;
				expect(p.type, `${name}.${fname} type mismatch (proto=${p.type} vs live=${liveTypeName})`).toBe(liveTypeName);
				expect(
					p.rule === "repeated",
					`${name}.${fname} repeated mismatch (proto=${p.rule} vs live=${l.repeated})`,
				).toBe(l.repeated);
			}
		}
	});

	it("core/graph.proto declares the three expected top-level messages", () => {
		// Regression guard: if someone renames or drops a message,
		// the field-set comparison above will not catch it.
		const parsed = parseProtoFile(readFileSync(findProtoFile(), "utf-8"));
		expect(Object.keys(parsed).sort()).toEqual(["EdgeColumn", "FileEdgeColumn", "GraphPayload"]);
	});
});
