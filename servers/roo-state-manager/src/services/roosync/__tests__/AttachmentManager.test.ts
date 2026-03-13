/**
 * Tests unitaires pour AttachmentManager (#674)
 * Utilise le vrai système de fichiers (tmpdir)
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { promises as fsPromises } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { AttachmentManager } from '../AttachmentManager.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `att-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSampleFile(dir: string, name: string, content = 'hello'): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('AttachmentManager', () => {
  let sharedStateDir: string;
  let workDir: string;
  let manager: AttachmentManager;

  beforeEach(() => {
    sharedStateDir = makeTempDir();
    workDir = makeTempDir();
    manager = new AttachmentManager(sharedStateDir);
  });

  afterEach(() => {
    rmSync(sharedStateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  // --- uploadAttachment ---

  test('creates UUID dir and copies file', async () => {
    const srcFile = makeSampleFile(workDir, 'report.txt', 'content here');
    const ref = await manager.uploadAttachment(srcFile, 'myia-po-2025');

    expect(ref.uuid).toBeTruthy();
    expect(ref.filename).toBe('report.txt');
    expect(ref.sizeBytes).toBeGreaterThan(0);

    const expectedDir = join(sharedStateDir, 'attachments', ref.uuid);
    expect(existsSync(expectedDir)).toBe(true);
    expect(existsSync(join(expectedDir, 'report.txt'))).toBe(true);
    expect(existsSync(join(expectedDir, 'metadata.json'))).toBe(true);
  });

  test('respects custom filename', async () => {
    const srcFile = makeSampleFile(workDir, 'original.txt');
    const ref = await manager.uploadAttachment(srcFile, 'myia-po-2025', 'renamed.txt');
    expect(ref.filename).toBe('renamed.txt');
  });

  test('stores messageId in metadata', async () => {
    const srcFile = makeSampleFile(workDir, 'file.txt');
    const ref = await manager.uploadAttachment(srcFile, 'myia-po-2025', undefined, 'msg-001');
    const meta = await manager.getAttachmentMetadata(ref.uuid);
    expect(meta?.messageId).toBe('msg-001');
  });

  test('throws when source file not found', async () => {
    await expect(
      manager.uploadAttachment('/non/existent/file.txt', 'myia-po-2025')
    ).rejects.toThrow('introuvable');
  });

  test('sets correct MIME type for .json', async () => {
    const srcFile = makeSampleFile(workDir, 'config.json', '{}');
    const ref = await manager.uploadAttachment(srcFile, 'myia-po-2025');
    const meta = await manager.getAttachmentMetadata(ref.uuid);
    expect(meta?.mimeType).toBe('application/json');
  });

  test('sets octet-stream for unknown extension', async () => {
    const srcFile = makeSampleFile(workDir, 'data.xyz', 'binary');
    const ref = await manager.uploadAttachment(srcFile, 'myia-po-2025');
    const meta = await manager.getAttachmentMetadata(ref.uuid);
    expect(meta?.mimeType).toBe('application/octet-stream');
  });

  // --- listAttachments ---

  test('returns empty array when no attachments', async () => {
    const result = await manager.listAttachments();
    expect(result).toEqual([]);
  });

  test('lists all attachments', async () => {
    const f1 = makeSampleFile(workDir, 'a.txt');
    const f2 = makeSampleFile(workDir, 'b.txt');
    await manager.uploadAttachment(f1, 'machine-a', undefined, 'msg-001');
    await manager.uploadAttachment(f2, 'machine-b', undefined, 'msg-002');

    const result = await manager.listAttachments();
    expect(result).toHaveLength(2);
  });

  test('filters by messageId', async () => {
    const f1 = makeSampleFile(workDir, 'a.txt');
    const f2 = makeSampleFile(workDir, 'b.txt');
    await manager.uploadAttachment(f1, 'machine-a', undefined, 'msg-001');
    await manager.uploadAttachment(f2, 'machine-b', undefined, 'msg-002');

    const result = await manager.listAttachments('msg-001');
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('msg-001');
  });

  // --- getAttachmentMetadata ---

  test('returns null for unknown UUID', async () => {
    const meta = await manager.getAttachmentMetadata('non-existent-uuid');
    expect(meta).toBeNull();
  });

  // --- getAttachment ---

  test('copies file to target path', async () => {
    const srcFile = makeSampleFile(workDir, 'hello.txt', 'hello world');
    const ref = await manager.uploadAttachment(srcFile, 'myia-po-2025');

    const targetPath = join(workDir, 'downloaded.txt');
    const meta = await manager.getAttachment(ref.uuid, targetPath);

    expect(existsSync(targetPath)).toBe(true);
    expect(meta.originalName).toBe('hello.txt');
  });

  test('throws for unknown UUID when getting', async () => {
    await expect(
      manager.getAttachment('bad-uuid', join(workDir, 'out.txt'))
    ).rejects.toThrow('introuvable');
  });

  // --- deleteAttachment ---

  test('removes UUID directory', async () => {
    const srcFile = makeSampleFile(workDir, 'bye.txt');
    const ref = await manager.uploadAttachment(srcFile, 'myia-po-2025');
    const expectedDir = join(sharedStateDir, 'attachments', ref.uuid);
    expect(existsSync(expectedDir)).toBe(true);

    await manager.deleteAttachment(ref.uuid);
    expect(existsSync(expectedDir)).toBe(false);
  });

  test('throws for unknown UUID when deleting', async () => {
    await expect(manager.deleteAttachment('ghost-uuid')).rejects.toThrow('introuvable');
  });

  // --- cleanupOldAttachments ---

  test('returns 0 when no attachments', async () => {
    const count = await manager.cleanupOldAttachments(30);
    expect(count).toBe(0);
  });

  test('deletes old attachments', async () => {
    const srcFile = makeSampleFile(workDir, 'old.txt');
    const ref = await manager.uploadAttachment(srcFile, 'machine-a');

    // Backdate the metadata to 32 days ago
    const metaPath = join(sharedStateDir, 'attachments', ref.uuid, 'metadata.json');
    const meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf-8'));
    meta.uploadedAt = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString();
    await fsPromises.writeFile(metaPath, JSON.stringify(meta), 'utf-8');

    const count = await manager.cleanupOldAttachments(30);
    expect(count).toBe(1);

    const expectedDir = join(sharedStateDir, 'attachments', ref.uuid);
    expect(existsSync(expectedDir)).toBe(false);
  });

  test('keeps recent attachments', async () => {
    const srcFile = makeSampleFile(workDir, 'recent.txt');
    await manager.uploadAttachment(srcFile, 'machine-a');

    const count = await manager.cleanupOldAttachments(30);
    expect(count).toBe(0);
  });
});
