/**
 * Tests for AttachmentManager — RooSync file attachment storage
 *
 * Uses real temp directories (no filesystem mocking).
 * Exercises upload, list, get, delete, and cleanup operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { AttachmentManager } from '../../../../src/services/roosync/AttachmentManager.js';

describe('AttachmentManager', () => {
  let manager: AttachmentManager;
  let sharedStateDir: string;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'attach-test-'));
    sharedStateDir = join(tempDir, '.shared-state');
    await mkdir(sharedStateDir, { recursive: true });
    manager = new AttachmentManager(sharedStateDir);
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // ================================================================
  // uploadAttachment
  // ================================================================
  describe('uploadAttachment', () => {
    it('should upload a file and return a ref', async () => {
      const srcFile = join(tempDir, 'test.txt');
      await writeFile(srcFile, 'Hello World');

      const ref = await manager.uploadAttachment(srcFile, 'machine-1');

      expect(ref.uuid).toBeDefined();
      expect(ref.filename).toBe('test.txt');
      expect(ref.sizeBytes).toBe(11);
    });

    it('should use custom filename when provided', async () => {
      const srcFile = join(tempDir, 'original.txt');
      await writeFile(srcFile, 'content');

      const ref = await manager.uploadAttachment(srcFile, 'machine-1', 'custom.md');

      expect(ref.filename).toBe('custom.md');
    });

    it('should create metadata.json with correct fields', async () => {
      const srcFile = join(tempDir, 'doc.json');
      await writeFile(srcFile, '{"key":"value"}');

      const ref = await manager.uploadAttachment(srcFile, 'machine-1', undefined, 'msg-123');

      const metadataPath = join(sharedStateDir, 'attachments', ref.uuid, 'metadata.json');
      expect(existsSync(metadataPath)).toBe(true);

      const meta = JSON.parse(await readFile(metadataPath, 'utf-8'));
      expect(meta.uuid).toBe(ref.uuid);
      expect(meta.originalName).toBe('doc.json');
      expect(meta.mimeType).toBe('application/json');
      expect(meta.sizeBytes).toBe(15);
      expect(meta.uploaderMachineId).toBe('machine-1');
      expect(meta.messageId).toBe('msg-123');
      expect(meta.uploadedAt).toBeDefined();
    });

    it('should create metadata without messageId when not provided', async () => {
      const srcFile = join(tempDir, 'file.txt');
      await writeFile(srcFile, 'data');

      const ref = await manager.uploadAttachment(srcFile, 'machine-1');

      const metadataPath = join(sharedStateDir, 'attachments', ref.uuid, 'metadata.json');
      const meta = JSON.parse(await readFile(metadataPath, 'utf-8'));
      expect(meta.messageId).toBeUndefined();
    });

    it('should throw if source file does not exist', async () => {
      await expect(
        manager.uploadAttachment('/nonexistent/file.txt', 'machine-1')
      ).rejects.toThrow('Fichier source introuvable');
    });

    it('should create attachments directory if missing', async () => {
      const srcFile = join(tempDir, 'a.txt');
      await writeFile(srcFile, 'x');

      expect(existsSync(join(sharedStateDir, 'attachments'))).toBe(false);

      await manager.uploadAttachment(srcFile, 'machine-1');

      expect(existsSync(join(sharedStateDir, 'attachments'))).toBe(true);
    });
  });

  // ================================================================
  // MIME type detection (exercised through upload)
  // ================================================================
  describe('MIME type detection', () => {
    it('should detect .ts as text/typescript', async () => {
      const srcFile = join(tempDir, 'module.ts');
      await writeFile(srcFile, 'export const x = 1;');

      const ref = await manager.uploadAttachment(srcFile, 'm1');
      const meta = await manager.getAttachmentMetadata(ref.uuid);
      expect(meta!.mimeType).toBe('text/typescript');
    });

    it('should detect .md as text/markdown', async () => {
      const srcFile = join(tempDir, 'readme.md');
      await writeFile(srcFile, '# Title');

      const ref = await manager.uploadAttachment(srcFile, 'm1');
      const meta = await manager.getAttachmentMetadata(ref.uuid);
      expect(meta!.mimeType).toBe('text/markdown');
    });

    it('should detect .png as image/png', async () => {
      const srcFile = join(tempDir, 'image.png');
      await writeFile(srcFile, Buffer.from([0x89, 0x50, 0x4E, 0x47]));

      const ref = await manager.uploadAttachment(srcFile, 'm1');
      const meta = await manager.getAttachmentMetadata(ref.uuid);
      expect(meta!.mimeType).toBe('image/png');
    });

    it('should return application/octet-stream for unknown extensions', async () => {
      const srcFile = join(tempDir, 'data.xyz');
      await writeFile(srcFile, 'binary');

      const ref = await manager.uploadAttachment(srcFile, 'm1');
      const meta = await manager.getAttachmentMetadata(ref.uuid);
      expect(meta!.mimeType).toBe('application/octet-stream');
    });

    it('should detect .ps1 as text/x-powershell', async () => {
      const srcFile = join(tempDir, 'script.ps1');
      await writeFile(srcFile, 'Write-Host "hi"');

      const ref = await manager.uploadAttachment(srcFile, 'm1');
      const meta = await manager.getAttachmentMetadata(ref.uuid);
      expect(meta!.mimeType).toBe('text/x-powershell');
    });

    it('should detect .yaml as application/yaml', async () => {
      const srcFile = join(tempDir, 'config.yaml');
      await writeFile(srcFile, 'key: value');

      const ref = await manager.uploadAttachment(srcFile, 'm1');
      const meta = await manager.getAttachmentMetadata(ref.uuid);
      expect(meta!.mimeType).toBe('application/yaml');
    });
  });

  // ================================================================
  // listAttachments
  // ================================================================
  describe('listAttachments', () => {
    it('should return empty array when no attachments', async () => {
      const result = await manager.listAttachments();
      expect(result).toEqual([]);
    });

    it('should return empty array when attachments dir does not exist', async () => {
      const freshManager = new AttachmentManager(join(tempDir, 'no-exist'));
      const result = await freshManager.listAttachments();
      expect(result).toEqual([]);
    });

    it('should list all uploaded attachments', async () => {
      const f1 = join(tempDir, 'a.txt');
      const f2 = join(tempDir, 'b.json');
      await writeFile(f1, 'aaa');
      await writeFile(f2, '{}');

      await manager.uploadAttachment(f1, 'm1');
      await manager.uploadAttachment(f2, 'm2');

      const list = await manager.listAttachments();
      expect(list).toHaveLength(2);
      expect(list.map(m => m.originalName).sort()).toEqual(['a.txt', 'b.json']);
    });

    it('should filter by messageId', async () => {
      const f1 = join(tempDir, 'a.txt');
      const f2 = join(tempDir, 'b.txt');
      await writeFile(f1, 'aaa');
      await writeFile(f2, 'bbb');

      await manager.uploadAttachment(f1, 'm1', undefined, 'msg-target');
      await manager.uploadAttachment(f2, 'm1', undefined, 'msg-other');

      const list = await manager.listAttachments('msg-target');
      expect(list).toHaveLength(1);
      expect(list[0].originalName).toBe('a.txt');
      expect(list[0].messageId).toBe('msg-target');
    });

    it('should return empty when no attachments match messageId filter', async () => {
      const f1 = join(tempDir, 'a.txt');
      await writeFile(f1, 'aaa');

      await manager.uploadAttachment(f1, 'm1', undefined, 'msg-1');

      const list = await manager.listAttachments('msg-nonexistent');
      expect(list).toEqual([]);
    });

    it('should skip entries with corrupted metadata', async () => {
      const srcFile = join(tempDir, 'good.txt');
      await writeFile(srcFile, 'good');

      await manager.uploadAttachment(srcFile, 'm1');

      const attachmentsDir = join(sharedStateDir, 'attachments');
      const corruptedDir = join(attachmentsDir, 'corrupted-uuid');
      await mkdir(corruptedDir, { recursive: true });
      await writeFile(join(corruptedDir, 'metadata.json'), 'not valid json');

      const list = await manager.listAttachments();
      expect(list).toHaveLength(1);
      expect(list[0].originalName).toBe('good.txt');
    });

    it('should skip non-directory entries in attachments dir', async () => {
      const srcFile = join(tempDir, 'good.txt');
      await writeFile(srcFile, 'good');

      await manager.uploadAttachment(srcFile, 'm1');

      const attachmentsDir = join(sharedStateDir, 'attachments');
      await writeFile(join(attachmentsDir, 'stray.txt'), 'stray');

      const list = await manager.listAttachments();
      expect(list).toHaveLength(1);
    });

    it('should skip directories without metadata.json', async () => {
      const srcFile = join(tempDir, 'good.txt');
      await writeFile(srcFile, 'good');

      await manager.uploadAttachment(srcFile, 'm1');

      const attachmentsDir = join(sharedStateDir, 'attachments');
      const emptyDir = join(attachmentsDir, 'empty-dir');
      await mkdir(emptyDir, { recursive: true });

      const list = await manager.listAttachments();
      expect(list).toHaveLength(1);
    });
  });

  // ================================================================
  // getAttachmentMetadata
  // ================================================================
  describe('getAttachmentMetadata', () => {
    it('should return metadata for existing attachment', async () => {
      const srcFile = join(tempDir, 'doc.md');
      await writeFile(srcFile, '# Doc');

      const ref = await manager.uploadAttachment(srcFile, 'm1', undefined, 'msg-1');
      const meta = await manager.getAttachmentMetadata(ref.uuid);

      expect(meta).not.toBeNull();
      expect(meta!.uuid).toBe(ref.uuid);
      expect(meta!.originalName).toBe('doc.md');
      expect(meta!.mimeType).toBe('text/markdown');
      expect(meta!.uploaderMachineId).toBe('m1');
      expect(meta!.messageId).toBe('msg-1');
    });

    it('should return null for non-existent UUID', async () => {
      const meta = await manager.getAttachmentMetadata('non-existent-uuid');
      expect(meta).toBeNull();
    });

    it('should return null for corrupted metadata file', async () => {
      const attachmentsDir = join(sharedStateDir, 'attachments');
      const corruptedDir = join(attachmentsDir, 'bad-uuid');
      await mkdir(corruptedDir, { recursive: true });
      await writeFile(join(corruptedDir, 'metadata.json'), '{{invalid}}');

      const meta = await manager.getAttachmentMetadata('bad-uuid');
      expect(meta).toBeNull();
    });
  });

  // ================================================================
  // getAttachment (download)
  // ================================================================
  describe('getAttachment', () => {
    it('should copy attachment file to target path', async () => {
      const srcFile = join(tempDir, 'source.txt');
      await writeFile(srcFile, 'payload data');

      const ref = await manager.uploadAttachment(srcFile, 'm1');

      const targetPath = join(tempDir, 'downloaded.txt');
      const meta = await manager.getAttachment(ref.uuid, targetPath);

      expect(meta.uuid).toBe(ref.uuid);
      expect(existsSync(targetPath)).toBe(true);
      const content = await readFile(targetPath, 'utf-8');
      expect(content).toBe('payload data');
    });

    it('should throw for non-existent UUID', async () => {
      const targetPath = join(tempDir, 'out.txt');
      await expect(
        manager.getAttachment('non-existent-uuid', targetPath)
      ).rejects.toThrow('Attachment introuvable');
    });

    it('should throw when attachment file is missing but metadata exists', async () => {
      const srcFile = join(tempDir, 'ephemeral.txt');
      await writeFile(srcFile, 'temp');

      const ref = await manager.uploadAttachment(srcFile, 'm1');

      // Delete the actual file but keep metadata
      const attachmentFile = join(sharedStateDir, 'attachments', ref.uuid, 'ephemeral.txt');
      await rm(attachmentFile);

      const targetPath = join(tempDir, 'out.txt');
      await expect(
        manager.getAttachment(ref.uuid, targetPath)
      ).rejects.toThrow('Fichier attachment introuvable');
    });
  });

  // ================================================================
  // deleteAttachment
  // ================================================================
  describe('deleteAttachment', () => {
    it('should delete attachment directory and its contents', async () => {
      const srcFile = join(tempDir, 'todelete.txt');
      await writeFile(srcFile, 'delete me');

      const ref = await manager.uploadAttachment(srcFile, 'm1');
      const attachmentDir = join(sharedStateDir, 'attachments', ref.uuid);

      expect(existsSync(attachmentDir)).toBe(true);

      await manager.deleteAttachment(ref.uuid);

      expect(existsSync(attachmentDir)).toBe(false);
    });

    it('should throw for non-existent UUID', async () => {
      await expect(
        manager.deleteAttachment('non-existent-uuid')
      ).rejects.toThrow('Attachment introuvable');
    });

    it('should remove attachment from subsequent listings', async () => {
      const srcFile = join(tempDir, 'remove.txt');
      await writeFile(srcFile, 'content');

      const ref = await manager.uploadAttachment(srcFile, 'm1');

      let list = await manager.listAttachments();
      expect(list).toHaveLength(1);

      await manager.deleteAttachment(ref.uuid);

      list = await manager.listAttachments();
      expect(list).toHaveLength(0);
    });
  });

  // ================================================================
  // cleanupOldAttachments
  // ================================================================
  describe('cleanupOldAttachments', () => {
    it('should delete attachments older than maxAgeDays', async () => {
      const srcFile = join(tempDir, 'old.txt');
      await writeFile(srcFile, 'old content');

      const ref = await manager.uploadAttachment(srcFile, 'm1');

      // Tamper with metadata to make it 31 days old
      const metadataPath = join(sharedStateDir, 'attachments', ref.uuid, 'metadata.json');
      const meta = JSON.parse(await readFile(metadataPath, 'utf-8'));
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 31);
      meta.uploadedAt = oldDate.toISOString();
      await writeFile(metadataPath, JSON.stringify(meta), 'utf-8');

      const deleted = await manager.cleanupOldAttachments(30);

      expect(deleted).toBe(1);
      expect(existsSync(join(sharedStateDir, 'attachments', ref.uuid))).toBe(false);
    });

    it('should keep attachments newer than maxAgeDays', async () => {
      const srcFile = join(tempDir, 'fresh.txt');
      await writeFile(srcFile, 'fresh content');

      const ref = await manager.uploadAttachment(srcFile, 'm1');

      const deleted = await manager.cleanupOldAttachments(30);

      expect(deleted).toBe(0);
      expect(existsSync(join(sharedStateDir, 'attachments', ref.uuid))).toBe(true);
    });

    it('should return 0 when attachments dir does not exist', async () => {
      const freshManager = new AttachmentManager(join(tempDir, 'no-exist'));
      const deleted = await freshManager.cleanupOldAttachments(30);
      expect(deleted).toBe(0);
    });

    it('should handle mixed old and new attachments', async () => {
      const oldFile = join(tempDir, 'old.txt');
      const newFile = join(tempDir, 'new.txt');
      await writeFile(oldFile, 'old');
      await writeFile(newFile, 'new');

      const oldRef = await manager.uploadAttachment(oldFile, 'm1');
      const newRef = await manager.uploadAttachment(newFile, 'm1');

      // Make oldRef 45 days old
      const oldMetaPath = join(sharedStateDir, 'attachments', oldRef.uuid, 'metadata.json');
      const oldMeta = JSON.parse(await readFile(oldMetaPath, 'utf-8'));
      const veryOld = new Date();
      veryOld.setDate(veryOld.getDate() - 45);
      oldMeta.uploadedAt = veryOld.toISOString();
      await writeFile(oldMetaPath, JSON.stringify(oldMeta), 'utf-8');

      const deleted = await manager.cleanupOldAttachments(30);

      expect(deleted).toBe(1);
      expect(existsSync(join(sharedStateDir, 'attachments', oldRef.uuid))).toBe(false);
      expect(existsSync(join(sharedStateDir, 'attachments', newRef.uuid))).toBe(true);
    });

    it('should skip entries with corrupted metadata during cleanup', async () => {
      const srcFile = join(tempDir, 'good.txt');
      await writeFile(srcFile, 'good');

      const goodRef = await manager.uploadAttachment(srcFile, 'm1');

      // Make the good attachment old enough to be cleaned (2 days old)
      const goodMetaPath = join(sharedStateDir, 'attachments', goodRef.uuid, 'metadata.json');
      const goodMeta = JSON.parse(await readFile(goodMetaPath, 'utf-8'));
      const twoDaysAgo = new Date();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      goodMeta.uploadedAt = twoDaysAgo.toISOString();
      await writeFile(goodMetaPath, JSON.stringify(goodMeta), 'utf-8');

      // Create a corrupted old attachment
      const attachmentsDir = join(sharedStateDir, 'attachments');
      const corruptedDir = join(attachmentsDir, 'corrupted-uuid');
      await mkdir(corruptedDir, { recursive: true });
      await writeFile(join(corruptedDir, 'metadata.json'), 'not json');

      // With 1 day, the good attachment is old and cleaned — but corrupted is skipped
      const deleted = await manager.cleanupOldAttachments(1);

      // Only the good attachment was cleaned (corrupted skipped)
      expect(deleted).toBe(1);
      // Corrupted dir still exists (was skipped)
      expect(existsSync(corruptedDir)).toBe(true);
    });

    it('should skip non-directory entries during cleanup', async () => {
      const attachmentsDir = join(sharedStateDir, 'attachments');
      await mkdir(attachmentsDir, { recursive: true });
      await writeFile(join(attachmentsDir, 'stray.txt'), 'stray');

      const deleted = await manager.cleanupOldAttachments(0);
      expect(deleted).toBe(0);
    });

    it('should use default maxAgeDays of 30', async () => {
      const srcFile = join(tempDir, 'edge.txt');
      await writeFile(srcFile, 'edge');

      const ref = await manager.uploadAttachment(srcFile, 'm1');

      // Make it exactly 29 days old — should be kept (cutoff is < 30 days ago)
      const metaPath = join(sharedStateDir, 'attachments', ref.uuid, 'metadata.json');
      const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
      const d29 = new Date();
      d29.setDate(d29.getDate() - 29);
      meta.uploadedAt = d29.toISOString();
      await writeFile(metaPath, JSON.stringify(meta), 'utf-8');

      const deleted = await manager.cleanupOldAttachments();
      expect(deleted).toBe(0);
      expect(existsSync(join(sharedStateDir, 'attachments', ref.uuid))).toBe(true);
    });
  });

  // ================================================================
  // Integration: full lifecycle
  // ================================================================
  describe('full lifecycle', () => {
    it('should support upload -> list -> get -> delete flow', async () => {
      const srcFile = join(tempDir, 'lifecycle.md');
      await writeFile(srcFile, '# Lifecycle test');

      // Upload
      const ref = await manager.uploadAttachment(srcFile, 'm1', 'report.md', 'msg-1');
      expect(ref.filename).toBe('report.md');

      // List
      const list = await manager.listAttachments('msg-1');
      expect(list).toHaveLength(1);
      expect(list[0].uuid).toBe(ref.uuid);

      // Get metadata
      const meta = await manager.getAttachmentMetadata(ref.uuid);
      expect(meta!.originalName).toBe('report.md');

      // Download
      const targetPath = join(tempDir, 'downloaded.md');
      await manager.getAttachment(ref.uuid, targetPath);
      const content = await readFile(targetPath, 'utf-8');
      expect(content).toBe('# Lifecycle test');

      // Delete
      await manager.deleteAttachment(ref.uuid);
      const afterDelete = await manager.listAttachments();
      expect(afterDelete).toHaveLength(0);
    });

    it('should handle multiple attachments independently', async () => {
      const f1 = join(tempDir, 'a.json');
      const f2 = join(tempDir, 'b.yaml');
      await writeFile(f1, '{"a":1}');
      await writeFile(f2, 'b: 2');

      const ref1 = await manager.uploadAttachment(f1, 'm1', undefined, 'msg-shared');
      const ref2 = await manager.uploadAttachment(f2, 'm2', undefined, 'msg-shared');

      const list = await manager.listAttachments('msg-shared');
      expect(list).toHaveLength(2);

      // Delete one
      await manager.deleteAttachment(ref1.uuid);

      const remaining = await manager.listAttachments('msg-shared');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].uuid).toBe(ref2.uuid);
      expect(remaining[0].mimeType).toBe('application/yaml');
    });
  });
});
