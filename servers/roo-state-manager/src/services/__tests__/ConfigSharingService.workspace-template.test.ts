/**
 * Tests ConfigSharingService — cible `workspace-template` (#3111)
 *
 * Contrats :
 *  - collect produit des entrées `workspace-template/<relative>` (layout préservé),
 *  - apply est CREATE-ONLY (jamais d'écrasement) et dryRun DÉFAUT = TRUE,
 *  - un journal est écrit en apply réel (fichiers + répertoires créés),
 *  - rollback supprime EXACTEMENT les fichiers du journal, laisse le reste intact,
 *  - chemins relatifs et segments `..` refusés.
 *
 * Tout sur répertoires FAKE (tmpdir) : templates, workspace, journals. Aucun
 * chemin réel de la machine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { ConfigSharingService } from '../ConfigSharingService';
import { IConfigService, IInventoryCollector } from '../../types/baseline';

vi.mock('../roosync/InventoryService', () => ({
  InventoryService: {
    getInstance: () => ({
      getMachineInventory: vi.fn().mockResolvedValue({
        paths: { rooExtensions: '/mock/roo-extensions', mcpSettings: '/mock/.claude.json' }
      })
    })
  }
}));

let fakeShared: string;
let templateDir: string;
let journalDir: string;
let workspaceDir: string;
let wsReal: string;
let service: ConfigSharingService;

const savedTemplateEnv = process.env.ROOSYNC_WORKSPACE_TEMPLATE_DIR;
const savedJournalEnv = process.env.ROOSYNC_WORKSPACE_TEMPLATE_JOURNAL_DIR;

/**
 * Construit un paquet publié factice {shared}/configs/test-machine/v1.0.0-… .
 * `manifestOverride` permet d'injecter une entrée pathologique (ex. `..`) que
 * l'on ne veut PAS écrire sur disque.
 */
function publishWorkspaceTemplatePackage(
  files: Record<string, string>,
  manifestOverride?: Array<{ path: string; hash: string; type: string; size: number }>
): { versionDir: string } {
  const versionDir = join(fakeShared, 'configs', 'test-machine', 'v1.0.0-2026-09-08T00-00-00Z');
  mkdirSync(versionDir, { recursive: true });
  const fileEntries = Object.keys(files).map(p => ({ path: p, hash: 'x', type: 'other', size: 1 }));
  const manifest = {
    version: '1.0.0',
    timestamp: '2026-09-08T00:00:00Z',
    author: 'test-machine',
    description: 'fixtures #3111',
    files: manifestOverride ?? fileEntries,
  };
  writeFileSync(join(versionDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  for (const [rel, content] of Object.entries(files)) {
    const p = join(versionDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf-8');
  }
  writeFileSync(join(fakeShared, 'configs', 'test-machine', 'latest.json'), JSON.stringify({
    version: '1.0.0', timestamp: '2026-09-08T00:00:00Z', path: versionDir, manifest,
  }), 'utf-8');
  return { versionDir };
}

beforeEach(() => {
  fakeShared = mkdtempSync(join(tmpdir(), 'css-wt-shared-'));
  templateDir = mkdtempSync(join(tmpdir(), 'css-wt-template-'));
  journalDir = mkdtempSync(join(tmpdir(), 'css-wt-journal-'));
  workspaceDir = mkdtempSync(join(tmpdir(), 'css-wt-workspace-'));
  wsReal = realpathSync(workspaceDir);

  // 2 fichiers dans un sous-répertoire (fixture de collecte)
  mkdirSync(join(templateDir, 'sub'), { recursive: true });
  writeFileSync(join(templateDir, 'CLAUDE.md.template'), '# template A\n', 'utf-8');
  writeFileSync(join(templateDir, 'sub', 'rule.md'), 'rule B\n', 'utf-8');

  process.env.ROOSYNC_WORKSPACE_TEMPLATE_DIR = templateDir;
  process.env.ROOSYNC_WORKSPACE_TEMPLATE_JOURNAL_DIR = journalDir;

  const mockConfigService = {
    getSharedStatePath: vi.fn().mockReturnValue(fakeShared),
  } as any as IConfigService;
  const mockInventoryCollector = {
    collectInventory: vi.fn().mockResolvedValue({}),
  } as any as IInventoryCollector;
  service = new ConfigSharingService(mockConfigService, mockInventoryCollector);
});

afterEach(() => {
  if (savedTemplateEnv === undefined) delete process.env.ROOSYNC_WORKSPACE_TEMPLATE_DIR;
  else process.env.ROOSYNC_WORKSPACE_TEMPLATE_DIR = savedTemplateEnv;
  if (savedJournalEnv === undefined) delete process.env.ROOSYNC_WORKSPACE_TEMPLATE_JOURNAL_DIR;
  else process.env.ROOSYNC_WORKSPACE_TEMPLATE_JOURNAL_DIR = savedJournalEnv;
  rmSync(fakeShared, { recursive: true, force: true });
  rmSync(templateDir, { recursive: true, force: true });
  rmSync(journalDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe('workspace-template — collect', () => {
  it('produit des entrées workspace-template/ (layout préservé)', async () => {
    const result = await service.collectConfig({ targets: ['workspace-template'] });

    expect(result.filesCount).toBe(2);
    expect(result.manifest.files.every(f => f.path.startsWith('workspace-template/'))).toBe(true);
    const paths = result.manifest.files.map(f => f.path).sort();
    expect(paths).toEqual([
      'workspace-template/CLAUDE.md.template',
      'workspace-template/sub/rule.md',
    ]);
    // Le contenu est bien copié dans le paquet
    expect(readFileSync(join(result.packagePath, 'workspace-template', 'sub', 'rule.md'), 'utf-8')).toBe('rule B\n');

    rmSync(result.packagePath, { recursive: true, force: true });
  });
});

describe('workspace-template — apply', () => {
  beforeEach(() => {
    publishWorkspaceTemplatePackage({
      'workspace-template/CLAUDE.md.template': '# template A\n',
      'workspace-template/sub/rule.md': 'rule B\n',
    });
    // Fichier pré-existant : ne doit JAMAIS être écrasé.
    writeFileSync(join(workspaceDir, 'CLAUDE.md.template'), 'PRE', 'utf-8');
  });

  it('dryRun non fourni (défaut TRUE) : prévoit les fichiers, n écrit rien, pas de journal', async () => {
    const result = await service.applyConfig({
      version: 'latest',
      machineId: 'test-machine',
      targets: ['workspace-template'],
      workspacePath: workspaceDir,
    });

    expect(result.errors).toEqual([]);
    expect(result.filesApplied).toBe(0);
    expect(result.workspaceTemplate?.simulate).toBe(true);
    // Seul sub/rule.md est prévu (CLAUDE.md.template existe déjà)
    expect(result.workspaceTemplate!.created).toEqual([join(wsReal, 'sub', 'rule.md')]);
    expect(result.workspaceTemplate!.skippedExisting).toEqual(['CLAUDE.md.template']);
    expect(result.workspaceTemplate!.journalPath).toBeNull();

    expect(existsSync(join(workspaceDir, 'sub', 'rule.md'))).toBe(false);
    expect(readdirSync(journalDir)).toHaveLength(0); // aucun journal écrit
  });

  it('dryRun:false crée les fichiers, ignore le pré-existant, écrit un journal', async () => {
    const result = await service.applyConfig({
      version: 'latest',
      machineId: 'test-machine',
      targets: ['workspace-template'],
      workspacePath: workspaceDir,
      dryRun: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.filesApplied).toBe(1);
    expect(result.workspaceTemplate?.simulate).toBe(false);
    expect(result.workspaceTemplate!.created).toEqual([join(wsReal, 'sub', 'rule.md')]);

    expect(readFileSync(join(workspaceDir, 'sub', 'rule.md'), 'utf-8')).toBe('rule B\n');
    expect(readFileSync(join(workspaceDir, 'CLAUDE.md.template'), 'utf-8')).toBe('PRE'); // intact

    const journals = readdirSync(journalDir);
    expect(journals).toHaveLength(1);
    const journal = JSON.parse(readFileSync(join(journalDir, journals[0]), 'utf-8'));
    expect(journal.files).toEqual([join(wsReal, 'sub', 'rule.md')]);
    expect(journal.createdDirs).toContain(join(wsReal, 'sub'));
    expect(journal.workspacePath).toBe(wsReal);
  });

  it('un second apply est un no-op (create-only, journal préservé)', async () => {
    await service.applyConfig({
      version: 'latest', machineId: 'test-machine',
      targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
    });
    const journalsAfterFirst = readdirSync(journalDir);
    const journalFirst = readFileSync(join(journalDir, journalsAfterFirst[0]), 'utf-8');

    const second = await service.applyConfig({
      version: 'latest', machineId: 'test-machine',
      targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
    });

    expect(second.errors).toEqual([]);
    expect(second.filesApplied).toBe(0);
    expect(second.workspaceTemplate!.created).toEqual([]);
    expect(second.workspaceTemplate!.skippedExisting.sort()).toEqual(['CLAUDE.md.template', 'sub/rule.md']);
    expect(readFileSync(join(workspaceDir, 'sub', 'rule.md'), 'utf-8')).toBe('rule B\n');
    expect(readFileSync(join(workspaceDir, 'CLAUDE.md.template'), 'utf-8')).toBe('PRE');
    // Le journal du premier apply n'est pas vidé par le no-op.
    expect(readFileSync(join(journalDir, journalsAfterFirst[0]), 'utf-8')).toBe(journalFirst);
  });

  it('refuse un workspacePath relatif', async () => {
    const result = await service.applyConfig({
      version: 'latest', machineId: 'test-machine',
      targets: ['workspace-template'], workspacePath: 'relative-workspace', dryRun: false,
    });
    expect(result.success).toBe(false);
    expect(result.errors!.some(e => e.includes('ABSOLU'))).toBe(true);
  });
});

describe('workspace-template — rollback', () => {
  beforeEach(() => {
    publishWorkspaceTemplatePackage({
      'workspace-template/CLAUDE.md.template': '# template A\n',
      'workspace-template/sub/rule.md': 'rule B\n',
    });
    writeFileSync(join(workspaceDir, 'CLAUDE.md.template'), 'PRE', 'utf-8');
  });

  it('supprime exactement les fichiers créés, laisse le pré-existant, retire le journal', async () => {
    await service.applyConfig({
      version: 'latest', machineId: 'test-machine',
      targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
    });
    const journals = readdirSync(journalDir);
    expect(journals).toHaveLength(1);

    const rb = await service.rollbackWorkspaceTemplateConfig({
      targets: ['workspace-template'],
      workspacePath: workspaceDir,
    });

    expect(rb.success).toBe(true);
    expect(rb.filesRemoved).toBe(1);
    expect(existsSync(join(workspaceDir, 'sub', 'rule.md'))).toBe(false);   // créé : supprimé
    expect(existsSync(join(workspaceDir, 'sub'))).toBe(false);              // répertoire élagué
    expect(readFileSync(join(workspaceDir, 'CLAUDE.md.template'), 'utf-8')).toBe('PRE'); // préservé
    expect(existsSync(join(journalDir, journals[0]))).toBe(false);          // journal retiré
  });

  it('un fichier créé puis MODIFIÉ est épargné (pas de suppression sans preuve)', async () => {
    await service.applyConfig({
      version: 'latest', machineId: 'test-machine',
      targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
    });
    writeFileSync(join(workspaceDir, 'sub', 'rule.md'), 'USER EDIT\n', 'utf-8');

    const rb = await service.rollbackWorkspaceTemplateConfig({
      targets: ['workspace-template'],
      workspacePath: workspaceDir,
    });

    expect(rb.success).toBe(true);
    expect(rb.filesRemoved).toBe(0);
    expect(rb.filesSkippedModified).toBe(1);
    expect(readFileSync(join(workspaceDir, 'sub', 'rule.md'), 'utf-8')).toBe('USER EDIT\n');
    // Le journal survit, réduit au seul fichier épargné.
    expect(existsSync(rb.journalPath!)).toBe(true);
    const kept = JSON.parse(readFileSync(rb.journalPath!, 'utf-8'));
    expect(kept.files).toEqual([join(wsReal, 'sub', 'rule.md')]);
    expect(kept.fileHashes[join(wsReal, 'sub', 'rule.md')]).toBeTruthy();
  });

  it('sans journal : erreur explicite', async () => {
    const rb = await service.rollbackWorkspaceTemplateConfig({
      targets: ['workspace-template'],
      workspacePath: workspaceDir,
    });
    expect(rb.success).toBe(false);
    expect(rb.errors.some(e => e.includes('no journal'))).toBe(true);
  });

  it('journal corrompu (entrée hors workspace) : rollback refusé, rien supprimé', async () => {
    await service.applyConfig({
      version: 'latest', machineId: 'test-machine',
      targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
    });
    const journals = readdirSync(journalDir);
    expect(journals).toHaveLength(1);
    const jp = join(journalDir, journals[0]);
    const journal = JSON.parse(readFileSync(jp, 'utf-8'));
    journal.files.push(join(tmpdir(), 'outside-victim.txt')); // cible hors workspace
    writeFileSync(jp, JSON.stringify(journal), 'utf-8');

    const rb = await service.rollbackWorkspaceTemplateConfig({
      targets: ['workspace-template'],
      workspacePath: workspaceDir,
    });

    expect(rb.success).toBe(false);
    expect(rb.errors.some(e => e.includes('journal refusé'))).toBe(true);
    expect(rb.filesRemoved).toBe(0);
    // Le fichier réellement créé est TOUJOURS là, et le journal aussi.
    expect(existsSync(join(workspaceDir, 'sub', 'rule.md'))).toBe(true);
    expect(existsSync(jp)).toBe(true);
  });

  it('rollback exige la target workspace-template', async () => {
    const rb = await service.rollbackWorkspaceTemplateConfig({
      targets: [],
      workspacePath: workspaceDir,
    });
    expect(rb.success).toBe(false);
    expect(rb.errors.some(e => e.includes('workspace-template'))).toBe(true);
  });
});

describe('workspace-template — refus des chemins pathologiques', () => {
  it('refuse un segment `..` dans une entrée de manifeste', async () => {
    publishWorkspaceTemplatePackage(
      { 'workspace-template/CLAUDE.md.template': '# template A\n' },
      [
        { path: 'workspace-template/CLAUDE.md.template', hash: 'x', type: 'other', size: 1 },
        { path: 'workspace-template/../../escape.txt', hash: 'x', type: 'other', size: 1 },
      ]
    );

    const result = await service.applyConfig({
      version: 'latest', machineId: 'test-machine',
      targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
    });

    expect(result.success).toBe(false);
    expect(result.errors!.some(e => e.includes('chemin invalide'))).toBe(true);
    expect(existsSync(join(workspaceDir, '..', 'escape.txt'))).toBe(false); // rien hors workspace
  });
});
