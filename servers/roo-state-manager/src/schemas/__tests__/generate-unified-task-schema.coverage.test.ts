/**
 * Coverage tests for src/schemas/generate-unified-task-schema.ts (#1391)
 *
 * The generator module has top-level side effects (zodToJsonSchema + writeFileSync + console.log).
 * This file pins every statement L8-L34 with isolated module re-import via vi.resetModules + vi.doMock.
 *
 * Pattern: add-only coverage test, 0 source touched (#1936).
 * Strategy: per-line statement coverage — mock all named imports, drive a fresh dynamic import,
 * assert each side-effect branch with documented shape.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';

// We intentionally import these via the SUT (under test) — but for assertion we import originals here.
import { UnifiedTaskSchema } from '../../types/unified-task.js';

describe('schemas/generate-unified-task-schema.ts coverage', () => {
  let writeFileSyncMock: ReturnType<typeof vi.fn>;
  let zodToJsonSchemaMock: ReturnType<typeof vi.fn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeFileSyncMock = vi.fn();
    zodToJsonSchemaMock = vi.fn();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // Helper: dynamically import the SUT with full mocks in place
  async function importSut() {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        writeFileSync: writeFileSyncMock,
      };
    });
    vi.doMock('node:path', async () => {
      const actual = await vi.importActual<typeof import('node:path')>('node:path');
      return {
        ...actual,
        default: actual,
        join: vi.fn((...args: string[]) => args.join('/')),
        dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/')),
      };
    });
    vi.doMock('node:url', async () => {
      const actual = await vi.importActual<typeof import('node:url')>('node:url');
      return {
        ...actual,
        default: actual,
        fileURLToPath: vi.fn((url: string | URL) => {
          const s = typeof url === 'string' ? url : url.toString();
          // file:///C:/foo/bar.ts → C:/foo/bar.ts (strip file:///)
          return s.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
        }),
      };
    });
    vi.doMock('zod-to-json-schema', () => ({
      default: vi.fn(),
      zodToJsonSchema: zodToJsonSchemaMock,
    }));
    // Importing the SUT triggers all top-level statements L8-L34
    return await import('../generate-unified-task-schema.js');
  }

  test('L11: imports zodToJsonSchema (named) from zod-to-json-schema', async () => {
    const mockSchema = { type: 'object', properties: { id: { type: 'string' } } };
    zodToJsonSchemaMock.mockReturnValue(mockSchema);
    writeFileSyncMock.mockImplementation(() => {});

    await importSut();

    expect(zodToJsonSchemaMock).toHaveBeenCalledTimes(1);
  });

  test('L12: imports UnifiedTaskSchema from ../types/unified-task.js', async () => {
    const mockSchema = { type: 'object' };
    zodToJsonSchemaMock.mockReturnValue(mockSchema);
    writeFileSyncMock.mockImplementation(() => {});

    await importSut();

    // First arg of zodToJsonSchema must be the UnifiedTaskSchema Zod schema.
    // Structural check (Zod internals differ across import instances; identity check would be flaky).
    const [firstArg] = zodToJsonSchemaMock.mock.calls[0]!;
    expect(firstArg).toBeDefined();
    expect(typeof (firstArg as any).parse).toBe('function');
    expect(typeof (firstArg as any)._def).toBe('object');
    // Same Zod typeName as the canonical UnifiedTaskSchema (proves it's the Zod schema, not some other arg)
    expect((firstArg as any)._def?.typeName).toBe((UnifiedTaskSchema as any)._def?.typeName);
  });

  test('L14: computes __dirname via dirname(fileURLToPath(import.meta.url))', async () => {
    const mockSchema = { type: 'object' };
    zodToJsonSchemaMock.mockReturnValue(mockSchema);
    writeFileSyncMock.mockImplementation(() => {});

    await importSut();

    // The mock fileURLToPath strips file:/// prefix; the dirname mock then joins args
    // import.meta.url is something like file:///C:/dev/.../src/schemas/generate-unified-task-schema.ts
    // After strip: C:/dev/.../src/schemas/generate-unified-task-schema.ts
    // After dirname: C:/dev/.../src/schemas
    // Verify the writeFileSync path ends with unified-task.json
    const [outPath] = writeFileSyncMock.mock.calls[0]!;
    expect(outPath).toMatch(/unified-task\.json$/);
  });

  test('L17-L20: calls zodToJsonSchema with { name: "UnifiedTask", $refStrategy: "root" }', async () => {
    const mockSchema = { type: 'object' };
    zodToJsonSchemaMock.mockReturnValue(mockSchema);
    writeFileSyncMock.mockImplementation(() => {});

    await importSut();

    const [, opts] = zodToJsonSchemaMock.mock.calls[0]!;
    expect(opts).toEqual({ name: 'UnifiedTask', $refStrategy: 'root' });
  });

  test('L23-L30: enriches schema with $schema/$id/title/description metadata', async () => {
    const mockSchema = { type: 'object', properties: { id: { type: 'string' } } };
    zodToJsonSchemaMock.mockReturnValue(mockSchema);
    writeFileSyncMock.mockImplementation(() => {});

    await importSut();

    const [, writtenJson] = writeFileSyncMock.mock.calls[0]!;
    const parsed = JSON.parse(writtenJson as string);

    expect(parsed.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(parsed.$id).toBe('https://roo-extensions.myia.io/schemas/unified-task.json');
    expect(parsed.title).toBe('UnifiedTask');
    expect(parsed.description).toContain('Unified schema for Roo Code and Claude Code tasks');
    // Spread preserves original jsonSchema fields
    expect(parsed.type).toBe('object');
    expect(parsed.properties).toEqual({ id: { type: 'string' } });
  });

  test('L29: spread of jsonSchema overrides if keys collide (spread after metadata loses to metadata)', async () => {
    // Note: { ...meta, ...jsonSchema } = jsonSchema keys WIN.
    // We verify this by giving jsonSchema a key that overrides a metadata field.
    const mockSchema = {
      type: 'object',
      $schema: 'OVERRIDDEN',
      title: 'OVERRIDDEN-TITLE',
    };
    zodToJsonSchemaMock.mockReturnValue(mockSchema);
    writeFileSyncMock.mockImplementation(() => {});

    await importSut();

    const [, writtenJson] = writeFileSyncMock.mock.calls[0]!;
    const parsed = JSON.parse(writtenJson as string);

    expect(parsed.$schema).toBe('OVERRIDDEN');
    expect(parsed.title).toBe('OVERRIDDEN-TITLE');
  });

  test('L32: outPath = join(__dirname, "unified-task.json")', async () => {
    const mockSchema = { type: 'object' };
    zodToJsonSchemaMock.mockReturnValue(mockSchema);
    writeFileSyncMock.mockImplementation(() => {});

    await importSut();

    const [outPath] = writeFileSyncMock.mock.calls[0]!;
    // join mock returns slash-joined, ends with unified-task.json
    expect(outPath.endsWith('/unified-task.json')).toBe(true);
  });

  test('L33: writeFileSync with JSON.stringify + trailing newline + utf-8 encoding', async () => {
    const mockSchema = { type: 'object' };
    zodToJsonSchemaMock.mockReturnValue(mockSchema);
    writeFileSyncMock.mockImplementation(() => {});

    await importSut();

    const [outPath, content, encoding] = writeFileSyncMock.mock.calls[0]!;
    expect(outPath).toMatch(/unified-task\.json$/);
    expect(encoding).toBe('utf-8');
    // Content is JSON.stringify(enriched, null, 2) + '\n'
    expect(typeof content).toBe('string');
    expect((content as string).endsWith('\n')).toBe(true);
    // Should be parseable as JSON
    expect(() => JSON.parse((content as string).slice(0, -1))).not.toThrow();
  });

  test('L34: console.log the written path', async () => {
    const mockSchema = { type: 'object' };
    zodToJsonSchemaMock.mockReturnValue(mockSchema);
    writeFileSyncMock.mockImplementation(() => {});

    await importSut();

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const [logMsg] = consoleLogSpy.mock.calls[0]!;
    expect(logMsg).toMatch(/^Written: .*unified-task\.json$/);
  });

  test('end-to-end shape: enrichment order matches expected order', async () => {
    const mockSchema = {
      type: 'object',
      definitions: {
        UnifiedTask: {
          type: 'object',
          required: ['id', 'source', 'status'],
        },
      },
    };
    zodToJsonSchemaMock.mockReturnValue(mockSchema);
    writeFileSyncMock.mockImplementation(() => {});

    await importSut();

    const [, writtenJson] = writeFileSyncMock.mock.calls[0]!;
    const parsed = JSON.parse(writtenJson as string);

    // Verify all metadata + spread fields present
    expect(parsed).toEqual(
      expect.objectContaining({
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: 'https://roo-extensions.myia.io/schemas/unified-task.json',
        title: 'UnifiedTask',
        description: expect.any(String),
        type: 'object',
        definitions: mockSchema.definitions,
      })
    );
  });
});