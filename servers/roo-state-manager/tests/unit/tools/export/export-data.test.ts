/**
 * Tests for export_data tool — schema and validation
 *
 * Tests the tool definition, schema, and handleExportData validation logic.
 */

import { describe, it, expect } from 'vitest';
import { exportDataTool } from '../../../../src/tools/export/export-data.js';
import { handleExportData } from '../../../../src/tools/export/export-data.js';

describe('export_data tool definition', () => {
  it('should have correct name', () => {
    expect(exportDataTool.name).toBe('export_data');
  });

  it('should require target and format', () => {
    const schema = exportDataTool.inputSchema as any;
    expect(schema.required).toContain('target');
    expect(schema.required).toContain('format');
  });

  it('should support xml, json, csv formats', () => {
    const schema = exportDataTool.inputSchema as any;
    const formatEnum = schema.properties.format.enum;
    expect(formatEnum).toContain('xml');
    expect(formatEnum).toContain('json');
    expect(formatEnum).toContain('csv');
  });

  it('should support task, conversation, project targets', () => {
    const schema = exportDataTool.inputSchema as any;
    const targetEnum = schema.properties.target.enum;
    expect(targetEnum).toContain('task');
    expect(targetEnum).toContain('conversation');
    expect(targetEnum).toContain('project');
  });

  it('should have jsonVariant with light and full options', () => {
    const schema = exportDataTool.inputSchema as any;
    expect(schema.properties.jsonVariant.enum).toContain('light');
    expect(schema.properties.jsonVariant.enum).toContain('full');
  });

  it('should have csvVariant with conversations, messages, tools options', () => {
    const schema = exportDataTool.inputSchema as any;
    expect(schema.properties.csvVariant.enum).toContain('conversations');
    expect(schema.properties.csvVariant.enum).toContain('messages');
    expect(schema.properties.csvVariant.enum).toContain('tools');
  });

  it('should have optional filePath parameter', () => {
    const schema = exportDataTool.inputSchema as any;
    expect(schema.properties.filePath).toBeDefined();
    expect(schema.properties.filePath.type).toBe('string');
  });

  it('should have optional truncationChars parameter', () => {
    const schema = exportDataTool.inputSchema as any;
    expect(schema.properties.truncationChars).toBeDefined();
    expect(schema.properties.truncationChars.type).toBe('number');
  });
});

describe('handleExportData — validation', () => {
  const emptyCache = new Map();
  const noopEnsureFresh = async () => {};
  const noopGetSkeleton = async () => null;

  // Create a minimal mock for XmlExporterService
  const mockXmlExporter = {} as any;

  it('should return error when target is missing', async () => {
    const result = await handleExportData(
      { format: 'xml' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, noopGetSkeleton
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('target');
  });

  it('should return error when format is missing', async () => {
    const result = await handleExportData(
      { target: 'task' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, noopGetSkeleton
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('format');
  });

  it('should return error for unsupported target/format combination', async () => {
    const result = await handleExportData(
      { target: 'task', format: 'json' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, noopGetSkeleton
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('non support');
  });

  it('should return error when taskId missing for target=task', async () => {
    const result = await handleExportData(
      { target: 'task', format: 'xml' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, noopGetSkeleton
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('taskId');
  });

  it('should return error when projectPath missing for target=project', async () => {
    const result = await handleExportData(
      { target: 'project', format: 'xml' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, noopGetSkeleton
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('projectPath');
  });

  it('should return error for task+json combination', async () => {
    const result = await handleExportData(
      { target: 'task', format: 'csv' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, noopGetSkeleton
    );
    expect(result.isError).toBe(true);
  });

  it('should return error for project+json combination', async () => {
    const result = await handleExportData(
      { target: 'project', format: 'json' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, noopGetSkeleton
    );
    expect(result.isError).toBe(true);
  });

  it('should return error when conversationId missing for conversation+xml', async () => {
    const result = await handleExportData(
      { target: 'conversation', format: 'xml' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, noopGetSkeleton
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('conversationId');
  });

  it('should return error when taskId missing for conversation+json', async () => {
    const result = await handleExportData(
      { target: 'conversation', format: 'json' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, noopGetSkeleton
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('taskId');
  });

  it('should return error when taskId missing for conversation+csv', async () => {
    const result = await handleExportData(
      { target: 'conversation', format: 'csv' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, noopGetSkeleton
    );
    expect(result.isError).toBe(true);
  });

  it('should return error for task not found', async () => {
    const result = await handleExportData(
      { target: 'task', format: 'xml', taskId: 'nonexistent-task' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, noopGetSkeleton
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('non trouv');
  });

  it('should return error for conversation root not found', async () => {
    const result = await handleExportData(
      { target: 'conversation', format: 'xml', conversationId: 'nonexistent-conv' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, noopGetSkeleton
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('non trouv');
  });

  it('should reject path traversal in filePath for json export', async () => {
    const getSkeleton = async () => ({ metadata: {}, messages: [] } as any);
    const result = await handleExportData(
      { target: 'conversation', format: 'json', taskId: 'task-1', filePath: '../../../etc/passwd' } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, getSkeleton
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('Unsafe');
  });

  it('should reject too long filePath for csv export', async () => {
    const longPath = 'a'.repeat(300);
    const getSkeleton = async () => ({ metadata: {}, messages: [] } as any);
    const result = await handleExportData(
      { target: 'conversation', format: 'csv', taskId: 'task-1', filePath: longPath } as any,
      emptyCache, mockXmlExporter, noopEnsureFresh, getSkeleton
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('too long');
  });
});
