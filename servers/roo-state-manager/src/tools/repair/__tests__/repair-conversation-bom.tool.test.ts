/**
 * Tests pour repair_conversation_bom.tool.ts
 *
 * Couvre :
 * - Détection BOM UTF-8 (0xEF 0xBB 0xBF)
 * - Réparation avec mode dry_run
 * - Gestion des erreurs (JSON invalide après suppression BOM)
 * - Génération du rapport
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { repairConversationBomTool } from '../repair-conversation-bom.tool.js';
import { RooStorageDetector } from '../../../utils/roo-storage-detector.js';
import { promises as fs } from 'fs';
import path from 'path';

// Mocks
vi.mock('../../../utils/roo-storage-detector.js');
vi.mock('fs', () => ({
  promises: {
    readdir: vi.fn(),
    access: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn()
  }
}));

const mockReaddir = vi.mocked(fs.readdir);
const mockAccess = vi.mocked(fs.access);
const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockDetectStorageLocations = vi.mocked(RooStorageDetector.detectStorageLocations);

describe('repairConversationBomTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('BOM detection', () => {
    it('should detect UTF-8 BOM (0xEF 0xBB 0xBF) in files', async () => {
      // Setup: Simuler un fichier avec BOM
      mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockReaddir.mockResolvedValue([
        { name: 'task-001', isDirectory: () => true } as any
      ] as any[]);
      mockAccess.mockResolvedValue(undefined);

      // Buffer avec BOM UTF-8 suivi de JSON valide
      const bomBuffer = Buffer.concat([
        Buffer.from([0xEF, 0xBB, 0xBF]), // BOM UTF-8
        Buffer.from('{"test": "value"}', 'utf-8')
      ]);
      mockReadFile.mockResolvedValue(bomBuffer);

      const result = await repairConversationBomTool.handler({ dry_run: true });

      // Vérifier que le BOM est détecté
      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toContain('Fichiers corrompus (BOM):** 1');
      expect(content.text).toContain('🔍');
    });

    it('should ignore files without BOM', async () => {
      mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockReaddir.mockResolvedValue([
        { name: 'task-001', isDirectory: () => true } as any
      ] as any[]);
      mockAccess.mockResolvedValue(undefined);

      // Buffer sans BOM
      const cleanBuffer = Buffer.from('{"test": "value"}', 'utf-8');
      mockReadFile.mockResolvedValue(cleanBuffer);

      const result = await repairConversationBomTool.handler({ dry_run: true });

      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toContain('Fichiers corrompus (BOM):** 0');
    });

    it('should handle incomplete BOM (only 2 bytes)', async () => {
      mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockReaddir.mockResolvedValue([
        { name: 'task-001', isDirectory: () => true } as any
      ] as any[]);
      mockAccess.mockResolvedValue(undefined);

      // Buffer avec seulement 2 octets du BOM (incomplet)
      const incompleteBom = Buffer.concat([
        Buffer.from([0xEF, 0xBB]), // Seulement 2/3 du BOM
        Buffer.from('{"test": "value"}', 'utf-8')
      ]);
      mockReadFile.mockResolvedValue(incompleteBom);

      const result = await repairConversationBomTool.handler({ dry_run: true });

      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toContain('Fichiers corrompus (BOM):** 0');
    });
  });

  describe('dry_run mode', () => {
    it('should not modify files when dry_run is true', async () => {
      mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockReaddir.mockResolvedValue([
        { name: 'task-001', isDirectory: () => true } as any
      ] as any[]);
      mockAccess.mockResolvedValue(undefined);

      const bomBuffer = Buffer.concat([
        Buffer.from([0xEF, 0xBB, 0xBF]),
        Buffer.from('{"test": "value"}', 'utf-8')
      ]);
      mockReadFile.mockResolvedValue(bomBuffer);

      await repairConversationBomTool.handler({ dry_run: true });

      // Vérifier que writeFile n'est jamais appelé en mode dry_run
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should report simulation mode in output', async () => {
      mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockReaddir.mockResolvedValue([
        { name: 'task-001', isDirectory: () => true } as any
      ] as any[]);
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(
        Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{}', 'utf-8')])
      );

      const result = await repairConversationBomTool.handler({ dry_run: true });

      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toContain('**Mode:** Simulation (dry-run)');
      expect(content.text).toContain('🔍 Simulation terminée'); // Message de fin de simulation
    });
  });

  describe('error handling', () => {
    it('should handle invalid JSON after BOM removal', async () => {
      mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockReaddir.mockResolvedValue([
        { name: 'task-001', isDirectory: () => true } as any
      ] as any[]);
      mockAccess.mockResolvedValue(undefined);

      // BOM suivi de JSON invalide
      const bomWithInvalidJson = Buffer.concat([
        Buffer.from([0xEF, 0xBB, 0xBF]),
        Buffer.from('{invalid json}', 'utf-8')
      ]);
      mockReadFile.mockResolvedValue(bomWithInvalidJson);

      const result = await repairConversationBomTool.handler({ dry_run: false });

      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toContain('Échecs de réparation:** 1');
      expect(content.text).toContain('❌'); // Le emoji ECHEC
    });

    it('should handle missing files gracefully', async () => {
      mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockReaddir.mockResolvedValue([
        { name: 'task-001', isDirectory: () => true } as any
      ] as any[]);

      // Fichier n'existe pas (access rejette)
      const accessError = new Error('ENOENT: no such file or directory');
      (accessError as NodeJS.ErrnoException).code = 'ENOENT';
      mockAccess.mockRejectedValue(accessError);

      const result = await repairConversationBomTool.handler({ dry_run: true });

      // Ne doit pas planter, mais rapporter aucun fichier analysé
      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toContain('Fichiers analysés:** 0');
    });

    it('should handle readdir errors gracefully', async () => {
      mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);

      // Erreur lors de la lecture du répertoire
      mockReaddir.mockRejectedValue(new Error('Permission denied'));

      const result = await repairConversationBomTool.handler({ dry_run: true });

      // Ne doit pas planter
      const content = result.content[0] as { type: string; text: string };
      expect(content).toBeDefined();
    });
  });

  describe('actual repair mode (dry_run: false)', () => {
    it('should strip BOM and write clean content', async () => {
      mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockReaddir.mockResolvedValue([
        { name: 'task-001', isDirectory: () => true } as any
      ] as any[]);
      mockAccess.mockResolvedValue(undefined);

      const originalJson = '{"key": "value", "number": 123}';
      const bomBuffer = Buffer.concat([
        Buffer.from([0xEF, 0xBB, 0xBF]),
        Buffer.from(originalJson, 'utf-8')
      ]);
      mockReadFile.mockResolvedValue(bomBuffer);

      await repairConversationBomTool.handler({ dry_run: false });

      // Vérifier que le contenu sans BOM est écrit
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('api_conversation_history.json'),
        originalJson, // Contenu SANS le BOM
        'utf-8'
      );
    });

    it('should validate JSON before writing', async () => {
      mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockReaddir.mockResolvedValue([
        { name: 'task-001', isDirectory: () => true } as any
      ] as any[]);
      mockAccess.mockResolvedValue(undefined);

      const bomWithInvalidJson = Buffer.concat([
        Buffer.from([0xEF, 0xBB, 0xBF]),
        Buffer.from('{broken}', 'utf-8')
      ]);
      mockReadFile.mockResolvedValue(bomWithInvalidJson);

      await repairConversationBomTool.handler({ dry_run: false });

      // Ne doit PAS écrire si le JSON est invalide
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('report generation', () => {
    it('should include detailed results in report', async () => {
      mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockReaddir.mockResolvedValue([
        { name: 'task-001', isDirectory: () => true } as any,
        { name: 'task-002', isDirectory: () => true } as any
      ] as any[]);
      mockAccess.mockResolvedValue(undefined);

      // Un fichier avec BOM, un sans
      mockReadFile.mockImplementation((filePath) => {
        if (filePath.toString().includes('task-001')) {
          return Promise.resolve(
            Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{}', 'utf-8')])
          );
        }
        return Promise.resolve(Buffer.from('{}', 'utf-8'));
      });

      const result = await repairConversationBomTool.handler({ dry_run: true });

      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toContain('Fichiers analysés:** 2');
      expect(content.text).toContain('Fichiers corrompus (BOM):** 1');
      expect(content.text).toContain('## Détails des opérations:');
    });
  });
});
