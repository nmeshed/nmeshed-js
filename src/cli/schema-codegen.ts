#!/usr/bin/env node
/**
 * nmeshed-schema CLI
 * 
 * Generates SDK-specific schema code from a unified definition.
 * Supports YAML, JSON, and Protobuf as input/output formats.
 * 
 * Usage:
 *   npx nmeshed-schema <input> [options]
 * 
 * Options:
 *   --output, -o   Output directory (default: ./generated)
 *   --lang, -l     Languages to generate: js, python, go, proto, json, yaml, all (default: all)
 *   --format, -f   Output format override (inferred from --lang by default)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

// ============================================================================
// Types
// ============================================================================

type PrimitiveType = 'string' | 'int32' | 'uint32' | 'int64' | 'uint64' | 'float32' | 'float64' | 'boolean' | 'bytes';

interface SchemaField {
    type: PrimitiveType | 'array' | 'map' | 'object';
    items?: SchemaField | string;      // For arrays
    values?: SchemaField | string;     // For maps (value type)
    properties?: Record<string, SchemaField | string>;  // For objects
}

interface TypeDefinition {
    [fieldName: string]: SchemaField | string;
}

interface SchemaDefinition {
    name: string;
    version: string;
    types: Record<string, TypeDefinition>;
}

// ============================================================================
// Parser
// ============================================================================

function parseInput(content: string, filePath: string): SchemaDefinition {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.yaml' || ext === '.yml') {
        return yaml.parse(content) as SchemaDefinition;
    } else if (ext === '.json') {
        return JSON.parse(content) as SchemaDefinition;
    } else if (ext === '.proto') {
        return parseProto(content);
    }

    // Try YAML first, fall back to JSON
    try {
        return yaml.parse(content) as SchemaDefinition;
    } catch {
        return JSON.parse(content) as SchemaDefinition;
    }
}

function parseProto(content: string): SchemaDefinition {
    // Simple proto3 parser
    const schema: SchemaDefinition = { name: 'proto', version: '1.0', types: {} };

    const packageMatch = content.match(/package\s+(\w+)/);
    if (packageMatch) schema.name = packageMatch[1];

    const messageRegex = /message\s+(\w+)\s*\{([^}]+)\}/g;
    let match;

    while ((match = messageRegex.exec(content)) !== null) {
        const typeName = match[1];
        const body = match[2];
        const fields: TypeDefinition = {};

        const fieldRegex = /(?:repeated\s+)?(\w+)\s+(\w+)\s*=\s*\d+/g;
        let fieldMatch;

        while ((fieldMatch = fieldRegex.exec(body)) !== null) {
            const protoType = fieldMatch[1];
            const fieldName = fieldMatch[2];
            const isRepeated = body.slice(fieldMatch.index - 10, fieldMatch.index).includes('repeated');

            const mappedType = mapProtoType(protoType);

            if (isRepeated) {
                fields[fieldName] = { type: 'array', items: mappedType };
            } else if (typeof mappedType === 'string') {
                fields[fieldName] = mappedType as any;
            } else {
                fields[fieldName] = mappedType;
            }
        }

        // Handle map<K, V> fields
        const mapRegex = /map<(\w+),\s*(\w+)>\s+(\w+)\s*=/g;
        while ((fieldMatch = mapRegex.exec(body)) !== null) {
            const valueType = fieldMatch[2];
            const fieldName = fieldMatch[3];
            fields[fieldName] = { type: 'map', values: mapProtoType(valueType) };
        }

        schema.types[typeName] = fields;
    }

    return schema;
}

function mapProtoType(protoType: string): SchemaField | string {
    const mapping: Record<string, string> = {
        'string': 'string',
        'int32': 'int32',
        'int64': 'int64',
        'uint32': 'uint32',
        'uint64': 'uint64',
        'float': 'float32',
        'double': 'float64',
        'bool': 'boolean',
        'bytes': 'bytes',
    };
    return mapping[protoType] || protoType; // Return as type reference if unknown
}

// ============================================================================
// Type Reference Resolution
// ============================================================================

function resolveTypeRef(ref: string, types: Record<string, TypeDefinition>): SchemaField {
    if (!types[ref]) {
        throw new Error(`Unknown type reference: ${ref}`);
    }
    return { type: 'object', properties: types[ref] };
}

function resolveField(field: SchemaField | string, types: Record<string, TypeDefinition>): SchemaField {
    // If it's a string, it's either a primitive or a type reference
    if (typeof field === 'string') {
        const primitives = ['string', 'int32', 'uint32', 'int64', 'uint64', 'float32', 'float64', 'boolean', 'bytes'];
        if (primitives.includes(field)) {
            return field as any; // Primitives stay as strings
        }
        return resolveTypeRef(field, types);
    }

    // Resolve nested references
    const resolved: SchemaField = { ...field };

    if (field.items) {
        resolved.items = resolveField(field.items, types);
    }
    if (field.values) {
        resolved.values = resolveField(field.values, types);
    }
    if (field.properties) {
        resolved.properties = {};
        for (const [k, v] of Object.entries(field.properties)) {
            resolved.properties[k] = resolveField(v, types);
        }
    }

    return resolved;
}

// ============================================================================
// Code Generators
// ============================================================================

function generateTypeScript(schema: SchemaDefinition): string {
    let output = `// Generated by nmeshed-schema from ${schema.name} v${schema.version}\n`;
    output += `// DO NOT EDIT MANUALLY\n\n`;
    output += `import { defineSchema } from 'nmeshed';\n\n`;

    for (const [typeName, fields] of Object.entries(schema.types)) {
        output += `export const ${typeName}Schema = defineSchema({\n`;
        for (const [fieldName, fieldType] of Object.entries(fields)) {
            const resolved = resolveField(fieldType, schema.types);
            const tsType = convertToTsSchemaField(resolved);
            output += `    ${fieldName}: ${tsType},\n`;
        }
        output += `});\n\n`;
    }

    return output;
}

function convertToTsSchemaField(field: SchemaField | string): string {
    if (typeof field === 'string') {
        return `'${field}'`;
    }

    switch (field.type) {
        case 'array':
            return `{ type: 'array', itemType: ${convertToTsSchemaField(field.items!)} }`;
        case 'map':
            return `{ type: 'map', schema: ${convertToTsSchemaField(field.values!)} }`;
        case 'object':
            const props = Object.entries(field.properties || {})
                .map(([k, v]) => `${k}: ${convertToTsSchemaField(v as SchemaField)}`)
                .join(', ');
            return `{ type: 'object', schema: { ${props} } }`;
        default:
            return `'${field.type}'`;
    }
}

function generatePython(schema: SchemaDefinition): string {
    let output = `# Generated by nmeshed-schema from ${schema.name} v${schema.version}\n`;
    output += `# DO NOT EDIT MANUALLY\n\n`;
    output += `from nmeshed.schema import Schema\n\n`;

    for (const [typeName, fields] of Object.entries(schema.types)) {
        output += `${typeName}Schema = Schema({\n`;
        for (const [fieldName, fieldType] of Object.entries(fields)) {
            const resolved = resolveField(fieldType, schema.types);
            const pyType = convertToPySchemaField(resolved);
            output += `    "${fieldName}": ${pyType},\n`;
        }
        output += `})\n\n`;
    }

    return output;
}

function convertToPySchemaField(field: SchemaField | string): string {
    if (typeof field === 'string') {
        return `"${field}"`;
    }

    switch (field.type) {
        case 'array':
            return `{"type": "array", "items": ${convertToPySchemaField(field.items as SchemaField)}}`;
        case 'map':
            return `{"type": "map", "values": ${convertToPySchemaField(field.values as SchemaField)}}`;
        case 'object':
            const props = Object.entries(field.properties || {})
                .map(([k, v]) => `"${k}": ${convertToPySchemaField(v as SchemaField)}`)
                .join(', ');
            return `{"type": "object", "properties": {${props}}}`;
        default:
            return `"${field.type}"`;
    }
}

function generateGo(schema: SchemaDefinition): string {
    let output = `// Generated by nmeshed-schema from ${schema.name} v${schema.version}\n`;
    output += `// DO NOT EDIT MANUALLY\n\n`;
    output += `package schema\n\n`;
    output += `import nmeshed "github.com/nmeshed/nmeshed-go/schema"\n\n`;

    for (const [typeName, fields] of Object.entries(schema.types)) {
        output += `var ${typeName}Schema = nmeshed.Define(map[string]interface{}{\n`;
        for (const [fieldName, fieldType] of Object.entries(fields)) {
            const resolved = resolveField(fieldType, schema.types);
            const goType = convertToGoSchemaField(resolved);
            output += `\t"${fieldName}": ${goType},\n`;
        }
        output += `})\n\n`;
    }

    return output;
}

function convertToGoSchemaField(field: SchemaField | string): string {
    if (typeof field === 'string') {
        return `"${field}"`;
    }

    switch (field.type) {
        case 'array':
            return `nmeshed.Array(${convertToGoSchemaField(field.items as SchemaField)})`;
        case 'map':
            return `nmeshed.Map(${convertToGoSchemaField(field.values as SchemaField)})`;
        case 'object':
            const props = Object.entries(field.properties || {})
                .map(([k, v]) => `"${k}": ${convertToGoSchemaField(v as SchemaField)}`)
                .join(', ');
            return `nmeshed.Object(map[string]interface{}{${props}})`;
        default:
            return `"${field.type}"`;
    }
}

function generateProto(schema: SchemaDefinition): string {
    let output = `// Generated by nmeshed-schema from ${schema.name} v${schema.version}\n`;
    output += `// DO NOT EDIT MANUALLY\n\n`;
    output += `syntax = "proto3";\n\n`;
    output += `package ${schema.name.replace(/-/g, '_')};\n\n`;

    for (const [typeName, fields] of Object.entries(schema.types)) {
        output += `message ${typeName} {\n`;
        let fieldNum = 1;
        for (const [fieldName, fieldType] of Object.entries(fields)) {
            const protoType = convertToProtoType(fieldType, schema.types);
            output += `    ${protoType} ${fieldName} = ${fieldNum++};\n`;
        }
        output += `}\n\n`;
    }

    return output;
}

function convertToProtoType(field: SchemaField | string, types: Record<string, TypeDefinition>): string {
    if (typeof field === 'string') {
        const mapping: Record<string, string> = {
            'string': 'string',
            'int32': 'int32',
            'int64': 'int64',
            'uint32': 'uint32',
            'uint64': 'uint64',
            'float32': 'float',
            'float64': 'double',
            'boolean': 'bool',
            'bytes': 'bytes',
        };
        return mapping[field] || field; // Return as message type if not primitive
    }

    switch (field.type) {
        case 'array':
            return `repeated ${convertToProtoType(field.items!, types)}`;
        case 'map':
            return `map<string, ${convertToProtoType(field.values!, types)}>`;
        case 'object':
            // For inline objects, we'd need to generate a nested message
            // For now, return a placeholder
            return 'bytes';
        default:
            const mapping: Record<string, string> = {
                'string': 'string', 'int32': 'int32', 'int64': 'int64',
                'uint32': 'uint32', 'uint64': 'uint64', 'float32': 'float',
                'float64': 'double', 'boolean': 'bool', 'bytes': 'bytes',
            };
            return mapping[field.type] || 'bytes';
    }
}

function generateJSON(schema: SchemaDefinition): string {
    return JSON.stringify(schema, null, 2);
}

function generateYAML(schema: SchemaDefinition): string {
    return `# Generated by nmeshed-schema\n${yaml.stringify(schema)}`;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
nmeshed-schema - Unified Schema Code Generator

Usage:
  npx nmeshed-schema <input> [options]

Options:
  -o, --output <dir>   Output directory (default: ./generated)
  -l, --lang <langs>   Languages to generate (comma-separated):
                       js, python, go, proto, json, yaml, all
                       (default: all)
  -h, --help           Show this help message

Examples:
  npx nmeshed-schema schema.yaml -o ./src/generated -l js,python
  npx nmeshed-schema schema.proto -o ./generated
  npx nmeshed-schema schema.json -l proto  # Convert JSON to Protobuf
`);
    process.exit(0);
}

const inputFile = args.find(a => !a.startsWith('-'));
const outputDir = args.includes('-o') ? args[args.indexOf('-o') + 1] :
    args.includes('--output') ? args[args.indexOf('--output') + 1] : './generated';
const langArg = args.includes('-l') ? args[args.indexOf('-l') + 1] :
    args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'all';

const langs = langArg === 'all'
    ? ['js', 'python', 'go', 'proto', 'json', 'yaml']
    : langArg.split(',').map(l => l.trim());

if (!inputFile) {
    console.error('Error: Input file required');
    process.exit(1);
}

const content = fs.readFileSync(inputFile, 'utf-8');
const schema = parseInput(content, inputFile);

fs.mkdirSync(outputDir, { recursive: true });

const generators: Record<string, { fn: (s: SchemaDefinition) => string; ext: string }> = {
    js: { fn: generateTypeScript, ext: 'schema.ts' },
    python: { fn: generatePython, ext: 'schema.py' },
    go: { fn: generateGo, ext: 'schema.go' },
    proto: { fn: generateProto, ext: 'schema.proto' },
    json: { fn: generateJSON, ext: 'schema.json' },
    yaml: { fn: generateYAML, ext: 'schema.yaml' },
};

for (const lang of langs) {
    const gen = generators[lang];
    if (!gen) {
        console.warn(`Unknown language: ${lang}`);
        continue;
    }
    const output = gen.fn(schema);
    const outPath = path.join(outputDir, gen.ext);
    fs.writeFileSync(outPath, output);
    console.log(`Generated: ${outPath}`);
}

console.log('Done!');
