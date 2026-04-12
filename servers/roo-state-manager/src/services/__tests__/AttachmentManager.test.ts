/**
 * Tests unitaires pour AttachmentManager
 *
 * Couvre :
 * - Construction et initialisation du répertoire
 * - Upload de fichiers avec métadonnées
 * - Liste des attachments avec filtres
 * - Récupération des métadonnées
 * - Téléchargement de fichiers
 * - Suppression d'attachments
 * - Nettoyage des attachments anciens
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AttachmentManager } from '../roosync/AttachmentManager.js';
import { existsSync, promises as fs, mkdirSync, rm } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Mock fs module
vi.mock('fs');
const mockFs = vi.mocked(fs);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);

describe('AttachmentManager', () => {
  let manager: AttachmentManager;
  const testSharedPath = '/tmp/test-shared-state';
  const attachmentsPath = join(testSharedPath, 'attachments');

  // Mock console pour éviter le bruit
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    manager = new AttachmentManager(testSharedPath);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // === Construction ===

  describe('constructor', () => {
    it('should initialize with correct attachments path', () => {
      expect(manager).toBeInstanceOf(AttachmentManager);
      // Le chemin est stocké en privé, on ne peut pas le vérifier directement
      // Mais on peut tester via les méthodes qui l'utilisent
    });
  });

  // === Upload ===

  describe('uploadAttachment', () => {
    const testFilePath = join(homedir(), 'test-file.txt');
    const testContent = 'Hello, World!';
    const machineId = 'test-machine-01';

    beforeEach(() => {
      // Mock file existence and content
      mockExistsSync.mockImplementation((path) => {
        return path === testFilePath;
      });

      // Mock stat pour la taille du fichier
      vi.spyOn(mockFs, 'stat').mockResolvedValue({
        size: Buffer.byteLength(testContent, 'utf-8'),
        isFile: () => true,
        isDirectory: () => false,
      } as any);
    });

    it('should upload attachment with default filename', async () => {
      // Mock file operations
      mockFs.copyFile.mockResolvedValue();
      mockFs.writeFile.mockResolvedValue();
      mockFs.mkdir.mockResolvedValue();

      const result = await manager.uploadAttachment(
        testFilePath,
        machineId
      );

      expect(result).toMatchObject({
        filename: 'test-file.txt',
        sizeBytes: Buffer.byteLength(testContent, 'utf-8'),
      });
      expect(result.uuid).toBeDefined();
      expect(result.uuid).toMatch(/^[0-9a-f-]+$/);

      // Vérifier les appels fs
      expect(mockFs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('attachments'),
        { recursive: true }
      );
      expect(mockFs.copyFile).toHaveBeenCalledWith(
        testFilePath,
        expect.stringContaining('test-file.txt')
      );
    });

    it('should upload attachment with custom filename', async () => {
      mockFs.copyFile.mockResolvedValue();
      mockFs.writeFile.mockResolvedValue();
      mockFs.mkdir.mockResolvedValue();

      const customFilename = 'custom-document.md';
      const result = await manager.uploadAttachment(
        testFilePath,
        machineId,
        customFilename
      );

      expect(result.filename).toBe(customFilename);
      expect(mockFs.copyFile).toHaveBeenCalledWith(
        testFilePath,
        expect.stringContaining(customFilename)
      );
    });

    it('should attach to message when messageId provided', async () => {
      mockFs.copyFile.mockResolvedValue();
      mockFs.writeFile.mockResolvedValue();
      mockFs.mkdir.mockResolvedValue();

      const messageId = 'msg-123';
      await manager.uploadAttachment(
        testFilePath,
        machineId,
        undefined,
        messageId
      );

      // Vérifier que metadata contient messageId
      const callArgs = mockFs.writeFile.mock.calls[0];
      const metadata = JSON.parse(callArgs[1]);
      expect(metadata.messageId).toBe(messageId);
    });

    it('should throw error for non-existent source file', async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(
        manager.uploadAttachment('/non/existent/file.txt', machineId)
      ).rejects.toThrow('Fichier source introuvable');
    });
  });

  // === Listing ===

  describe('listAttachments', () => {
    beforeEach(() => {
      mockFs.readdir.mockResolvedValue([
        { name: 'uuid1', isDirectory: () => true },
        { name: 'uuid2', isDirectory: () => true },
        { name: 'not-a-dir', isDirectory: () => false },
      ] as any);

      // Mock existsSync pour retourner true pour les répertoires et les metadata.json
      mockExistsSync.mockImplementation((path) => {
        return path.includes('metadata.json') ||
               path === attachmentsPath ||
               path.includes('uuid1') ||
               path.includes('uuid2');
      });
    });

    it('should return empty array when attachments dir does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await manager.listAttachments();

      expect(result).toEqual([]);
    });

    it('should list all attachments', async () => {
      const mockMetadata1 = {
        uuid: 'uuid1',
        originalName: 'file1.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        uploadedAt: '2024-01-01T00:00:00.000Z',
        uploaderMachineId: 'machine-1',
      };

      const mockMetadata2 = {
        uuid: 'uuid2',
        originalName: 'file2.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 200,
        uploadedAt: '2024-01-02T00:00:00.000Z',
        uploaderMachineId: 'machine-2',
      };

      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(mockMetadata1))
        .mockResolvedValueOnce(JSON.stringify(mockMetadata2));

      // Utiliser la configuration de existsSync déjà définie dans beforeEach
      const result = await manager.listAttachments();

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(mockMetadata1);
      expect(result).toContainEqual(mockMetadata2);
    });

    it('should filter attachments by messageId', async () => {
      const mockMetadata1 = {
        uuid: 'uuid1',
        originalName: 'file1.txt',
        messageId: 'msg-123',
        // ... other fields
      };

      const mockMetadata2 = {
        uuid: 'uuid2',
        originalName: 'file2.txt',
        // no messageId
        // ... other fields
      };

      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(mockMetadata1))
        .mockResolvedValueOnce(JSON.stringify(mockMetadata2));

      mockExistsSync.mockReturnValue(true);

      const result = await manager.listAttachments('msg-123');

      expect(result).toHaveLength(1);
      expect(result[0].uuid).toBe('uuid1');
    });

    it('should handle corrupted metadata gracefully', async () => {
      mockFs.readdir.mockResolvedValue([
        { name: 'bad-uuid', isDirectory: () => true },
      ] as any);

      mockFs.readFile.mockResolvedValue('invalid json');
      mockExistsSync.mockReturnValue(true);

      const result = await manager.listAttachments();

      // Should return empty array when metadata is invalid
      expect(result).toEqual([]);
    });
  });

  // === Metadata retrieval ===

  describe('getAttachmentMetadata', () => {
    it('should return metadata for existing attachment', async () => {
      const mockMetadata = {
        uuid: 'test-uuid',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        uploadedAt: '2024-01-01T00:00:00.000Z',
        uploaderMachineId: 'test-machine',
      };

      mockExistsSync.mockReturnValue(true);
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockMetadata));

      const result = await manager.getAttachmentMetadata('test-uuid');

      expect(result).toEqual(mockMetadata);
    });

    it('should return null for non-existent attachment', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await manager.getAttachmentMetadata('non-existent-uuid');

      expect(result).toBeNull();
    });

    it('should handle JSON parse errors gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readFile.mockResolvedValue('invalid json');

      const result = await manager.getAttachmentMetadata('bad-uuid');

      expect(result).toBeNull();
    });
  });

  // === Download ===

  describe('getAttachment', () => {
    const targetPath = '/tmp/downloaded-file.txt';

    beforeEach(() => {
      mockFs.copyFile.mockResolvedValue();
    });

    it('should download attachment successfully', async () => {
      const mockMetadata = {
        uuid: 'test-uuid',
        originalName: 'source.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        uploadedAt: '2024-01-01T00:00:00.000Z',
        uploaderMachineId: 'test-machine',
      };

      mockExistsSync.mockImplementation((path) => {
        return path.includes('metadata.json') || path.includes('source.txt');
      });
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockMetadata));

      const result = await manager.getAttachment('test-uuid', targetPath);

      expect(result).toEqual(mockMetadata);
      expect(mockFs.copyFile).toHaveBeenCalledWith(
        expect.stringContaining('source.txt'),
        targetPath
      );
    });

    it('should throw error for non-existent attachment', async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(
        manager.getAttachment('non-existent-uuid', targetPath)
      ).rejects.toThrow('Attachment introuvable');
    });

    it('should throw error for missing file', async () => {
      const mockMetadata = {
        uuid: 'test-uuid',
        originalName: 'missing.txt',
        // ... other fields
      };

      mockExistsSync.mockImplementation((path) => {
        return path.includes('metadata.json');
      });
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockMetadata));

      await expect(
        manager.getAttachment('test-uuid', targetPath)
      ).rejects.toThrow('Fichier attachment introuvable');
    });
  });

  // === Deletion ===

  describe('deleteAttachment', () => {
    beforeEach(() => {
      mockFs.rm.mockResolvedValue();
    });

    it('should delete attachment successfully', async () => {
      mockExistsSync.mockReturnValue(true);

      await manager.deleteAttachment('test-uuid');

      expect(mockFs.rm).toHaveBeenCalledWith(
        expect.stringContaining('test-uuid'),
        { recursive: true, force: true }
      );
    });

    it('should throw error for non-existent attachment', async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(
        manager.deleteAttachment('non-existent-uuid')
      ).rejects.toThrow('Attachment introuvable');
    });
  });

  // === Cleanup ===

  describe('cleanupOldAttachments', () => {
    const veryOldDate = '2023-01-01T00:00:00.000Z';
    const recentDate = '2024-01-15T00:00:00.000Z';

    beforeEach(() => {
      mockFs.readdir.mockResolvedValue([
        { name: 'old-uuid', isDirectory: () => true },
        { name: 'recent-uuid', isDirectory: () => true },
      ] as any);
      mockFs.rm.mockResolvedValue();
    });

    it('should clean up attachments older than max age', async () => {
      const mockOldMetadata = {
        uuid: 'old-uuid',
        originalName: 'old.txt',
        uploadedAt: veryOldDate,
        uploaderMachineId: 'machine-1',
      };

      const mockRecentMetadata = {
        uuid: 'recent-uuid',
        originalName: 'recent.txt',
        uploadedAt: recentDate,
        uploaderMachineId: 'machine-2',
      };

      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(mockOldMetadata))
        .mockResolvedValueOnce(JSON.stringify(mockRecentMetadata));

      // Avancer le temps pour que la date de cutoff soit dans le passé
      const advanceTime = 20 * 24 * 60 * 60 * 1000; // 20 jours
      vi.advanceTimersByTime(advanceTime);

      const result = await manager.cleanupOldAttachments(10); // 10 days

      expect(result).toBe(1); // Only old attachment should be deleted
      expect(mockFs.rm).toHaveBeenCalledWith(
        expect.stringContaining('old-uuid'),
        { recursive: true, force: true }
      );
    });

    it('should return 0 when attachments dir does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await manager.cleanupOldAttachments(10);

      expect(result).toBe(0);
    });

    it('should handle cleanup errors gracefully', async () => {
      mockFs.readdir.mockResolvedValue([
        { name: 'problem-uuid', isDirectory: () => true },
      ] as any);

      mockFs.readFile.mockResolvedValue('invalid json');
      mockExistsSync.mockReturnValue(true);

      const result = await manager.cleanupOldAttachments(10);

      expect(result).toBe(0); // No attachments should be deleted
    });
  });
});