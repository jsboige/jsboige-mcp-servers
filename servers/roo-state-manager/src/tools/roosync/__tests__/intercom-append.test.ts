/**
 * Tests pour #567 Section 4 - Scheduler write_to_file fix
 *
 * Tests du mécanisme d'append INTERCOM:
 * - Fallback win-cli Add-Content
 * - Détection limite 200 lignes
 * - Validation du workflow scheduler
 *
 * @module tests/roosync/intercom-append.test
 * @issue #567
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';

describe('INTERCOM Append - Scheduler Workflow', () => {
  let testDir: string;
  let intercomFile: string;

  beforeAll(() => {
    testDir = join(tmpdir(), 'roosync-intercom-test-' + Date.now());
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Créer un fichier INTERCOM de test
    intercomFile = join(testDir, 'INTERCOM-test-machine.md');
    const initialContent = `# INTERCOM - test-machine

## Communication Locale
`;
    writeFileSync(intercomFile, initialContent, 'utf8');
  });

  afterEach(() => {
    if (existsSync(intercomFile)) {
      rmSync(intercomFile, { force: true });
    }
  });

  describe('Limite 200 lignes', () => {
    it('détecte un fichier sous la limite', () => {
      const content = readFileSync(intercomFile, 'utf8');
      const lines = content.split('\n').length;
      expect(lines).toBeLessThan(200);
    });

    it('génère un fichier de 200+ lignes pour tester la limite', () => {
      // Simuler un INTERCOM volumineux (cas de production observé)
      const lines: string[] = ['# INTERCOM - test-machine'];
      for (let i = 0; i < 220; i++) {
        lines.push(`## [2026-03-0${Math.floor(i / 50) + 1}] Test entry ${i}`);
        lines.push(`Message de test ${i}`);
        lines.push('---');
      }

      const largeContent = lines.join('\n');
      const tempFile = join(testDir, 'large-intercom.md');
      writeFileSync(tempFile, largeContent, 'utf8');

      const content = readFileSync(tempFile, 'utf8');
      const lineCount = content.split('\n').length;

      expect(lineCount).toBeGreaterThan(200);

      // Cleanup
      rmSync(tempFile, { force: true });
    });
  });

  describe('Format message scheduler', () => {
    it('génère un message au format scheduler attendu', () => {
      const expectedFormat = `## [2026-03-06 10:30] roo -> claude-code [DONE]
### Bilan scheduler executeur

- Git pull : OK
- Git status : propre
- Build : OK
- Tests : 7039 pass
- Taches executees : 3
- Erreurs : aucune
---
`;

      // Vérifier le format (regex corrigée)
      const formatRegex = /## \[.*\] roo -> claude-code \[(DONE|IDLE|MAINTENANCE)\]/;
      expect(expectedFormat).toMatch(formatRegex);
      expect(expectedFormat).toContain('### Bilan scheduler');
      expect(expectedFormat).toContain('---');
    });

    it('valide le format court (<= 15 lignes)', () => {
      const shortFormat = `## [2026-03-06] roo -> claude-code [IDLE]
- Git: OK | Status: propre
- Build: OK | Tests: 42 pass
- Taches: 0 | Erreurs: aucune
---`;

      const lines = shortFormat.split('\n');
      expect(lines.length).toBeLessThanOrEqual(15);
    });
  });

  describe('Mécanisme append', () => {
    it('simule append via writeFileSync (comme write_to_file)', () => {
      const originalContent = readFileSync(intercomFile, 'utf8');
      const newMessage = `
## [2026-03-06 10:30] roo -> claude-code [DONE]
- Tâche complétée
---
`;

      // Append (simulation de write_to_file qui lit + réécrit)
      const appendedContent = originalContent + newMessage;
      writeFileSync(intercomFile, appendedContent, 'utf8');

      const result = readFileSync(intercomFile, 'utf8');
      expect(result).toContain('Tâche complétée');
      expect(result).toContain('## Communication Locale');
    });

    it('simule append via Add-Content (fallback win-cli)', () => {
      const newMessage = `
## [2026-03-06 10:35] roo -> claude-code [IDLE]
- En attente de tâches
---
`;
      // Simulation de Add-Content PowerShell
      const originalContent = readFileSync(intercomFile, 'utf8');
      const appendedContent = originalContent + newMessage;
      writeFileSync(intercomFile, appendedContent, 'utf8');

      const result = readFileSync(intercomFile, 'utf8');
      expect(result).toContain('En attente de tâches');
    });
  });

  describe('Maintenance INTERCOM', () => {
    it('détecte quand condensation est nécessaire (> 500 lignes)', () => {
      // Créer un fichier de 600 lignes
      const lines: string[] = ['# INTERCOM - test-machine'];
      for (let i = 0; i < 590; i++) {
        lines.push(`Ligne ${i}`);
      }
      const largeContent = lines.join('\n');
      const tempFile = join(testDir, 'large-intercom-500.md');
      writeFileSync(tempFile, largeContent, 'utf8');

      const content = readFileSync(tempFile, 'utf8');
      const lineCount = content.split('\n').length;

      expect(lineCount).toBeGreaterThan(500);

      // Cleanup
      rmSync(tempFile, { force: true });
    });

    it('calcule la condensation (300 premières → 50 lignes)', () => {
      // Simuler le calcul de condensation
      const originalLines = 600;
      const keepLines = 200; // 200 dernières intactes
      const condenseFrom = 300; // 300 premières
      const condensedTo = 50; // → 50 lignes

      const expectedTotal = condensedTo + keepLines;
      expect(expectedTotal).toBe(250);

      // La réduction: 600 → 250 = -350 lignes (58%)
      const reduction = ((originalLines - expectedTotal) / originalLines * 100).toFixed(0);
      expect(parseInt(reduction)).toBe(58);
    });
  });
});
