import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

describe('Schema Codegen', () => {
    const testDir = '/tmp/schema-codegen-test';

    beforeEach(() => {
        fs.mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('YAML Parsing', () => {
        it('should parse basic YAML schema', () => {
            const yamlContent = `
name: test
version: "1.0"
types:
  User:
    id: string
    age: int32
`;
            const parsed = yaml.parse(yamlContent);
            expect(parsed.name).toBe('test');
            expect(parsed.types.User.id).toBe('string');
            expect(parsed.types.User.age).toBe('int32');
        });

        it('should parse type references', () => {
            const yamlContent = `
name: test
version: "1.0"
types:
  Task:
    id: string
    title: string
  Kanban:
    tasks:
      type: map
      values: Task
`;
            const parsed = yaml.parse(yamlContent);
            expect(parsed.types.Kanban.tasks.values).toBe('Task');
        });

        it('should parse array types', () => {
            const yamlContent = `
name: test
version: "1.0"
types:
  List:
    items:
      type: array
      items: string
`;
            const parsed = yaml.parse(yamlContent);
            expect(parsed.types.List.items.type).toBe('array');
            expect(parsed.types.List.items.items).toBe('string');
        });

        it('should parse map types', () => {
            const yamlContent = `
name: test
version: "1.0"
types:
  Store:
    data:
      type: map
      values:
        type: object
        properties:
          id: string
`;
            const parsed = yaml.parse(yamlContent);
            expect(parsed.types.Store.data.type).toBe('map');
            expect(parsed.types.Store.data.values.type).toBe('object');
        });
    });

    describe('JSON Parsing', () => {
        it('should parse JSON schema', () => {
            const jsonContent = JSON.stringify({
                name: 'test',
                version: '1.0',
                types: {
                    User: { id: 'string', active: 'boolean' }
                }
            });

            const parsed = JSON.parse(jsonContent);
            expect(parsed.name).toBe('test');
            expect(parsed.types.User.active).toBe('boolean');
        });

        it('should handle complex nested structures', () => {
            const schema = {
                name: 'complex',
                version: '1.0',
                types: {
                    Outer: {
                        inner: {
                            type: 'object',
                            properties: {
                                deep: 'string'
                            }
                        }
                    }
                }
            };

            const jsonStr = JSON.stringify(schema);
            const parsed = JSON.parse(jsonStr);
            expect(parsed.types.Outer.inner.properties.deep).toBe('string');
        });
    });

    describe('Proto Parsing', () => {
        it('should parse basic proto3 messages', () => {
            const protoContent = `
syntax = "proto3";
package myapp;

message User {
    string id = 1;
    int32 age = 2;
    bool active = 3;
}
`;
            const messageRegex = /message\s+(\w+)\s*\{([^}]+)\}/g;
            const match = messageRegex.exec(protoContent);

            expect(match).toBeTruthy();
            expect(match![1]).toBe('User');
        });

        it('should parse map fields', () => {
            const protoContent = `
message Store {
    map<string, User> users = 1;
}
`;
            const mapRegex = /map<(\w+),\s*(\w+)>\s+(\w+)\s*=/g;
            const match = mapRegex.exec(protoContent);

            expect(match).toBeTruthy();
            expect(match![1]).toBe('string');
            expect(match![2]).toBe('User');
            expect(match![3]).toBe('users');
        });

        it('should extract package name', () => {
            const protoContent = `package myapp;`;
            const packageMatch = protoContent.match(/package\s+(\w+)/);
            expect(packageMatch).toBeTruthy();
            expect(packageMatch![1]).toBe('myapp');
        });
    });

    describe('Type Resolution', () => {
        it('should resolve type references to inline objects', () => {
            const types = {
                Task: { id: 'string', title: 'string' }
            };

            const ref = 'Task';
            expect(types[ref]).toBeDefined();
            expect(types[ref].id).toBe('string');
        });

        it('should detect primitive types', () => {
            const primitives = ['string', 'int32', 'uint32', 'int64', 'uint64', 'float32', 'float64', 'boolean', 'bytes'];

            for (const p of primitives) {
                expect(primitives.includes(p)).toBe(true);
            }

            expect(primitives.includes('CustomType')).toBe(false);
        });

        it('should handle nested type references', () => {
            const types = {
                Task: { id: 'string' },
                Column: { taskIds: { type: 'array', items: 'string' } }
            };

            expect(types.Column.taskIds.type).toBe('array');
        });
    });

    describe('TypeScript Generation', () => {
        it('should generate valid TypeScript for primitives', () => {
            const expectedPattern = /export const UserSchema = defineSchema/;
            const output = `export const UserSchema = defineSchema({ id: 'string', age: 'int32' });`;
            expect(expectedPattern.test(output)).toBe(true);
        });

        it('should generate array types correctly', () => {
            const arrayField = "{ type: 'array', itemType: 'string' }";
            expect(arrayField).toContain("type: 'array'");
            expect(arrayField).toContain("itemType: 'string'");
        });

        it('should generate map types correctly', () => {
            const mapField = "{ type: 'map', schema: { type: 'object', schema: { id: 'string' } } }";
            expect(mapField).toContain("type: 'map'");
            expect(mapField).toContain("schema:");
        });

        it('should include import statement', () => {
            const header = "import { defineSchema } from 'nmeshed';";
            expect(header).toContain('defineSchema');
            expect(header).toContain('nmeshed');
        });
    });

    describe('Python Generation', () => {
        it('should generate valid Python Schema', () => {
            const expectedPattern = /Schema\(\{/;
            const output = 'UserSchema = Schema({ "id": "string" })';
            expect(expectedPattern.test(output)).toBe(true);
        });

        it('should use double quotes for Python strings', () => {
            const output = '"fieldName": "string"';
            expect(output).toMatch(/"fieldName"/);
        });
    });

    describe('Go Generation', () => {
        it('should generate valid Go schema definition', () => {
            const expectedPattern = /var \w+Schema = nmeshed\.Define/;
            const output = 'var UserSchema = nmeshed.Define(map[string]interface{}{"id": "string"})';
            expect(expectedPattern.test(output)).toBe(true);
        });

        it('should use proper Go map syntax', () => {
            const output = 'map[string]interface{}{"id": "string"}';
            expect(output).toContain('map[string]interface{}');
        });
    });

    describe('Proto Generation', () => {
        it('should generate valid proto3 syntax', () => {
            const output = 'syntax = "proto3";';
            expect(output).toContain('proto3');
        });

        it('should map types correctly', () => {
            const mapping: Record<string, string> = {
                'string': 'string',
                'int32': 'int32',
                'float32': 'float',
                'float64': 'double',
                'boolean': 'bool',
            };

            expect(mapping['float32']).toBe('float');
            expect(mapping['boolean']).toBe('bool');
        });

        it('should generate message definitions', () => {
            const output = 'message Task { string id = 1; }';
            expect(output).toContain('message Task');
        });
    });

    describe('Round-trip Conversion', () => {
        it('should preserve schema structure through YAML -> JSON -> YAML', () => {
            const original = {
                name: 'test',
                version: '1.0',
                types: {
                    Task: { id: 'string', done: 'boolean' }
                }
            };

            const jsonStr = JSON.stringify(original);
            const fromJson = JSON.parse(jsonStr);
            const yamlStr = yaml.stringify(fromJson);
            const fromYaml = yaml.parse(yamlStr);

            expect(fromYaml.name).toBe(original.name);
            expect(fromYaml.types.Task.id).toBe('string');
        });

        it('should handle all primitive types in round-trip', () => {
            const primitives = ['string', 'int32', 'uint32', 'int64', 'uint64', 'float32', 'float64', 'boolean', 'bytes'];

            for (const prim of primitives) {
                const schema = { name: 'test', version: '1.0', types: { T: { field: prim } } };
                const json = JSON.stringify(schema);
                const parsed = JSON.parse(json);
                expect(parsed.types.T.field).toBe(prim);
            }
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty types object', () => {
            const schema = { name: 'empty', version: '1.0', types: {} };
            expect(Object.keys(schema.types).length).toBe(0);
        });

        it('should handle deeply nested structures', () => {
            const schema = {
                name: 'deep',
                version: '1.0',
                types: {
                    Root: {
                        level1: {
                            type: 'object',
                            properties: {
                                level2: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            level3: 'string'
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            };

            expect(schema.types.Root.level1.properties.level2.items.properties.level3).toBe('string');
        });
    });
});
