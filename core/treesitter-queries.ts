/**
 * pi-shazam core/treesitter-queries -- Tree-sitter query patterns for 18 languages.
 *
 * Ported from repomap/src/queries.py.
 * Each language has patterns for: function, class, import, call, http_route.
 */

export interface QueryDict {
	[lang: string]: {
		function?: string;
		class?: string;
		import?: string;
		call?: string;
		ref?: string;
	};
}

export const QUERIES: QueryDict = {
	python: {
		function: `\
(function_definition name: (identifier) @name) @definition.function
(decorated_definition (function_definition name: (identifier) @name)) @definition.function
(class_definition body: (block (function_definition name: (identifier) @name))) @definition.method
(assignment left: (identifier) @name right: (lambda)) @definition.lambda
`,
		class: `\
(class_definition name: (identifier) @name) @definition.class
(decorated_definition (class_definition name: (identifier) @name)) @definition.class
`,
		import: `\
(import_statement name: (dotted_name) @name)
(import_statement name: (aliased_import name: (dotted_name) @name))
(import_from_statement module_name: (dotted_name) @name)
(import_from_statement module_name: (relative_import) @name)
`,
		call: `\
(call function: (identifier) @name) @reference.call
(call function: (attribute attribute: (identifier) @name)) @reference.call
`,
	},
	javascript: {
		function: `\
(function_declaration name: (identifier) @name) @definition.function
(variable_declarator name: (identifier) @name value: (arrow_function)) @definition.function
(variable_declarator name: (identifier) @name value: (function_expression)) @definition.function
(method_definition name: (property_identifier) @name) @definition.method
`,
		class: `\
(class_declaration name: (identifier) @name) @definition.class
`,
		import: `\
(import_statement source: (string) @source)
(import_specifier name: (identifier) @name)
(import_clause (identifier) @name)
`,
		call: `\
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
`,
		ref: `\
	(call_expression arguments: (arguments (identifier) @name))
	(return_statement (identifier) @name)
	`,
	},
	typescript: {
		function: `\
(function_declaration name: (identifier) @name) @definition.function
(variable_declarator name: (identifier) @name value: (arrow_function)) @definition.function
(variable_declarator name: (identifier) @name value: (call_expression function: (identifier) @_fn (#match? @_fn "^(createContext|create|use[A-Z])"))) @definition.function
(method_definition name: (property_identifier) @name) @definition.method
`,
		class: `\
(class_declaration name: (_) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type_alias
(enum_declaration name: (identifier) @name) @definition.enum
`,
		import: `\
(import_statement source: (string) @source)
(import_specifier name: (identifier) @name)
(import_clause (identifier) @name)
`,
		call: `\
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
`,
		ref: `\
	(call_expression arguments: (arguments (identifier) @name))
	(return_statement (identifier) @name)
	`,
	},
	go: {
		function: `\
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
`,
		class: `\
(type_spec name: (type_identifier) @name type: (struct_type)) @definition.struct
(type_spec name: (type_identifier) @name type: (interface_type)) @definition.interface
`,
		import: `\
(import_spec path: (interpreted_string_literal) @path)
`,
		call: `\
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (selector_expression field: (field_identifier) @name)) @reference.call
`,
	},
	rust: {
		function: `\
(function_item name: (identifier) @name) @definition.function
(function_signature_item name: (identifier) @name) @definition.trait_method
`,
		class: `\
(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(impl_item type: (type_identifier) @name) @definition.impl
(type_item name: (type_identifier) @name) @definition.type
(mod_item name: (identifier) @name) @definition.module
`,
		import: `\
(use_declaration argument: (scoped_identifier) @name)
(use_declaration argument: (identifier) @name)
(extern_crate_declaration name: (identifier) @name)
(mod_item name: (identifier) @name)
`,
		call: `\
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
(call_expression function: (scoped_identifier name: (identifier) @name)) @reference.call
`,
	},
	c: {
		function: `\
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
`,
		class: `\
(struct_specifier name: (type_identifier) @name) @definition.struct
(union_specifier name: (type_identifier) @name) @definition.union
(enum_specifier name: (type_identifier) @name) @definition.enum
`,
		import: `\
(preproc_include path: (_) @path)
`,
		call: `\
(call_expression function: (identifier) @name) @reference.call
`,
	},
	cpp: {
		function: `\
(function_definition declarator: (function_declarator declarator: [(identifier) (qualified_identifier)] @name)) @definition.function
`,
		class: `\
(class_specifier name: (type_identifier) @name) @definition.class
(struct_specifier name: (type_identifier) @name) @definition.struct
(enum_specifier name: (type_identifier) @name) @definition.enum
`,
		import: `\
(preproc_include path: (_) @path)
`,
		call: `\
(call_expression function: [(identifier) (qualified_identifier)] @name) @reference.call
`,
	},
	java: {
		function: `\
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.method
`,
		class: `\
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
`,
		import: `\
(import_declaration (scoped_identifier) @name)
(import_declaration (identifier) @name)
`,
		call: `\
(method_invocation name: (identifier) @name) @reference.call
`,
	},
	c_sharp: {
		function: `\
(method_declaration name: (identifier) @name) @definition.method
(local_function_statement name: (identifier) @name) @definition.function
`,
		class: `\
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(struct_declaration name: (identifier) @name) @definition.struct
(enum_declaration name: (identifier) @name) @definition.enum
`,
		import: `\
(using_directive name: [(identifier) (qualified_name)] @name)
`,
		call: `\
(invocation_expression function: (identifier) @name) @reference.call
(invocation_expression function: (member_access_expression name: (identifier) @name)) @reference.call
`,
	},
	ruby: {
		function: `\
(method name: (identifier) @name) @definition.method
(singleton_method name: (identifier) @name) @definition.method
`,
		class: `\
(class name: (constant) @name) @definition.class
(module name: (constant) @name) @definition.module
`,
		import: `\
(call method: (identifier) @_method arguments: (argument_list (string) @path))
(#match? @_method "^(require|require_relative|load)$")
`,
		call: `\
(call method: (identifier) @name) @reference.call
`,
	},
	html: {},
	css: {},
	json: {},
	// Dart queries -- based on @sengac/tree-sitter-dart grammar node types.
	// NOTE: @sengac/tree-sitter-dart@1.x requires tree-sitter >=0.24 (ABI mismatch
	// with tree-sitter 0.22.4). Parser loading fails gracefully via try-catch in
	// _loadGrammar until tree-sitter is upgraded. Queries are matched against
	// node-types.json in the grammar package and will activate once tree-sitter
	// is upgraded to a compatible version.
	dart: {
		function: `\
(function_signature name: (identifier) @name) @definition.function
(getter_signature name: (identifier) @name) @definition.method
(setter_signature name: (identifier) @name) @definition.method
(constructor_signature name: (identifier) @name) @definition.method
(factory_constructor_signature (identifier) @name) @definition.method
(local_function_declaration (lambda_expression parameters: (function_signature name: (identifier) @name))) @definition.function
`,
		class: `\
(class_definition name: (identifier) @name) @definition.class
(mixin_declaration (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.class
(extension_declaration name: (identifier) @name) @definition.class
`,
		import: `\
(import_specification (configurable_uri (uri (string_literal) @source)))
`,
		call: `\
(constructor_invocation (identifier) @name) @reference.call
(constructor_invocation (type_identifier) @name) @reference.call
(new_expression (identifier) @name) @reference.call
(new_expression (type_identifier) @name) @reference.call
`,
	},
};

// TSX uses the same queries as typescript
QUERIES["tsx"] = QUERIES["typescript"]!;
