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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, promises as fsPromises } from 'fs';
import { createHash } from 'crypto';
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
  manifestOverride?: Array<{ path: string; hash: string; type: string; size: number }>,
  machineId = 'test-machine'
): { versionDir: string } {
  const versionDir = join(fakeShared, 'configs', machineId, 'v1.0.0-2026-09-08T00-00-00Z');
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
  writeFileSync(join(fakeShared, 'configs', machineId, 'latest.json'), JSON.stringify({
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

describe('workspace-template — échec d’écriture en milieu de boucle (revue po-2028, 23/11)', () => {
  it('journalise ce qui est déjà écrit, ne laisse ni fichier tronqué ni .tmp, et reste réparable', async () => {
    publishWorkspaceTemplatePackage({
      'workspace-template/a.md': 'A\n',
      'workspace-template/sub/b.md': 'B\n',
      'workspace-template/sub/deep/c.md': 'C\n',
    });

    // Injecte un ENOSPC sur le 2ᵉ fichier (le 1ᵉʳ doit être créé et journalisé).
    const realWriteFile = fsPromises.writeFile.bind(fsPromises);
    let tmpWrites = 0;
    const spy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(((file: any, data: any, opts?: any) => {
      if (String(file).includes('.roosync-wt-tmp-')) {
        tmpWrites++;
        if (tmpWrites === 2) return Promise.reject(new Error('ENOSPC injected'));
      }
      return realWriteFile(file, data, opts);
    }) as any);

    let result: any;
    try {
      result = await service.applyConfig({
        version: 'latest', machineId: 'test-machine',
        targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
      });
    } finally {
      spy.mockRestore();
    }

    // Le caller REÇOIT l'état partiel (avant le correctif, workspaceTemplate restait indéfini).
    expect(result.workspaceTemplate).toBeDefined();
    expect(result.workspaceTemplate.created).toEqual([join(wsReal, 'a.md')]);
    expect(result.errors.some((e: string) => e.includes('ENOSPC injected'))).toBe(true);

    // Ce qui est sur disque est COMPLET ; le journal porte l'INTENTION (a + b),
    // b n'existant pas encore — le rollback ignore les entrées non réalisées.
    expect(readFileSync(join(workspaceDir, 'a.md'), 'utf-8')).toBe('A\n');
    expect(existsSync(join(workspaceDir, 'sub', 'b.md'))).toBe(false);
    const journalPath = result.workspaceTemplate.journalPath;
    expect(journalPath).toBeTruthy();
    expect(existsSync(journalPath)).toBe(true);
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
    expect(journal.files.sort()).toEqual([join(wsReal, 'a.md'), join(wsReal, 'sub', 'b.md')].sort());
    expect(journal.fileHashes[join(wsReal, 'a.md')])
      .toBe(createHash('sha256').update('A\n').digest('hex'));
    expect(journal.fileHashes[join(wsReal, 'sub', 'b.md')]).toBeTruthy();

    // Aucun fichier temporaire orphelin, à TOUS les niveaux du workspace.
    const temps: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.includes('.roosync-wt-tmp-')) temps.push(p);
      }
    };
    walk(workspaceDir);
    expect(temps).toEqual([]);

    // Un rollback sur cet état partiel ne supprime QUE ce qui existe réellement
    // (l'entrée b non réalisée est ignorée, jamais une erreur) : dry-run = 1.
    const rbDry = await service.rollbackWorkspaceTemplateConfig({
      targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: true,
    });
    expect(rbDry.success).toBe(true);
    expect(rbDry.filesRemoved).toBe(1);

    // Réparable : un nouvel apply complète SANS réécrire a.md, et le journal s'enrichit.
    const retry = await service.applyConfig({
      version: 'latest', machineId: 'test-machine',
      targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
    });
    expect(retry.errors).toEqual([]);
    expect(retry.workspaceTemplate!.created.sort())
      .toEqual([join(wsReal, 'sub', 'b.md'), join(wsReal, 'sub', 'deep', 'c.md')].sort());
    expect(retry.workspaceTemplate!.skippedExisting).toEqual(['a.md']);

    // Le rollback retrouve les TROIS fichiers — y compris celui du run échoué.
    const rb = await service.rollbackWorkspaceTemplateConfig({
      targets: ['workspace-template'],
      workspacePath: workspaceDir,
    });
    expect(rb.success).toBe(true);
    expect(rb.filesRemoved).toBe(3);
    expect(readdirSync(workspaceDir)).toEqual([]);
  });
});

describe('workspace-template — applies concurrents / repli copyFile (revue coordinateur, 24/11)', () => {
  /** Échoue net (message explicite) si un point de rendez-vous n'est jamais atteint. */
  const within = async <T>(p: Promise<T>, what: string, ms = 5000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`point de rendez-vous jamais atteint : ${what}`)), ms);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  it('deux applies entrelacés ne se perdent pas leurs entrées de journal', async () => {
    // Deux paquets DISTINCTS : chacun crée un fichier que l'autre ne journalise pas.
    publishWorkspaceTemplatePackage({
      'workspace-template/a1.md': 'A1\n',
      'workspace-template/a2.md': 'A2\n',
    });
    publishWorkspaceTemplatePackage({ 'workspace-template/b1.md': 'B1\n' }, undefined, 'other-machine');
    const pA1 = join(wsReal, 'a1.md');
    const pA2 = join(wsReal, 'a2.md');
    const pB1 = join(wsReal, 'b1.md');

    // Ordonnancement imposé : A publie a1 (journal = {a1}) et s'arrête ENTRE deux
    // flush ; B s'exécute COMPLET pendant l'attente (journal = {a1, b1}) ; A
    // reprend et solde a2. C'est le dernier écrivain.
    const realLink = fsPromises.link.bind(fsPromises);
    let parked!: () => void;
    const parkedP = new Promise<void>(r => { parked = r; });
    let release!: () => void;
    const releaseP = new Promise<void>(r => { release = r; });
    const linkSpy = vi.spyOn(fsPromises, 'link').mockImplementation(((src: any, dest: any) => {
      const linked = realLink(src, dest);
      if (!String(dest).endsWith('a1.md')) return linked;
      return linked.then(async () => { parked(); await releaseP; });
    }) as any);

    let aRes: any;
    let bRes: any;
    try {
      const a = service.applyConfig({
        version: 'latest', machineId: 'test-machine',
        targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
      });
      await within(parkedP, 'A n’a jamais publié a1.md');
      bRes = await service.applyConfig({
        version: 'latest', machineId: 'other-machine',
        targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
      });
      release();
      aRes = await within(a, 'A n’a pas repris');
    } finally {
      linkSpy.mockRestore();
    }

    expect(aRes.errors).toEqual([]);
    expect(bRes.errors).toEqual([]);
    expect(aRes.workspaceTemplate!.created.sort()).toEqual([pA1, pA2].sort());
    expect(bRes.workspaceTemplate!.created).toEqual([pB1]);

    // L'entrée de B doit SURVIVRE à la réécriture finale de A : sans relecture du
    // journal à chaque flush, A réécrit depuis son seul instantané de départ et
    // le rollback ne peut plus retirer b1.
    const journalPath = aRes.workspaceTemplate!.journalPath ?? bRes.workspaceTemplate!.journalPath;
    expect(journalPath).toBeTruthy();
    const journal = JSON.parse(readFileSync(journalPath!, 'utf-8'));
    expect([...journal.files].sort()).toEqual([pA1, pA2, pB1].sort());
    expect(journal.fileHashes[pB1]).toBe(createHash('sha256').update('B1\n').digest('hex'));

    const rbDry = await service.rollbackWorkspaceTemplateConfig({
      targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: true,
    });
    expect(rbDry.filesRemoved).toBe(3);
  });

  it('une course create-only perdue en milieu de boucle retire bien l’entrée du journal', async () => {
    publishWorkspaceTemplatePackage({
      'workspace-template/a.md': 'A\n',
      'workspace-template/sub/b.md': 'B\n',
    });

    // Un autre acteur crée a.md entre l'intention journalisée et la publication.
    const realLink = fsPromises.link.bind(fsPromises);
    const linkSpy = vi.spyOn(fsPromises, 'link').mockImplementation(((src: any, dest: any) => {
      if (!String(dest).endsWith('a.md')) return realLink(src, dest);
      return fsPromises.writeFile(dest, 'FOREIGN\n').then(() => {
        throw Object.assign(new Error('EEXIST injected'), { code: 'EEXIST' });
      });
    }) as any);

    let result: any;
    try {
      result = await service.applyConfig({
        version: 'latest', machineId: 'test-machine',
        targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
      });
    } finally {
      linkSpy.mockRestore();
    }

    const pA = join(wsReal, 'a.md');
    const pB = join(wsReal, 'sub', 'b.md');
    expect(result.errors).toEqual([]);
    expect(result.workspaceTemplate!.skippedExisting).toEqual(['a.md']);
    expect(readFileSync(join(workspaceDir, 'a.md'), 'utf-8')).toBe('FOREIGN\n');
    // a.md n'est PAS de notre fait : son intention doit rester retirée du journal,
    // alors même que le flush le RELIT depuis le disque.
    const journal = JSON.parse(readFileSync(result.workspaceTemplate!.journalPath, 'utf-8'));
    expect(journal.files).toEqual([pB]);
    expect(journal.fileHashes[pA]).toBeUndefined();
  });

  it('un échec copyFile de repli ne laisse PAS de destination partielle', async () => {
    publishWorkspaceTemplatePackage({ 'workspace-template/a.md': 'A\n' });

    // Le repli n'est atteint que si `link` échoue pour une raison AUTRE que EEXIST
    // (FS sans liens durs) ; `copyFile` peut alors échouer APRÈS avoir créé la
    // destination (copie interrompue, ex. ENOSPC en cours d'écriture) : sans
    // retrait, un fichier TRONQUÉ reste sur disque.
    const linkSpy = vi.spyOn(fsPromises, 'link').mockRejectedValue(Object.assign(new Error('EPERM injected'), { code: 'EPERM' }));
    const copySpy = vi.spyOn(fsPromises, 'copyFile').mockImplementation((async (src: any, dest: any) => {
      await fsPromises.writeFile(dest, 'PARTIAL');
      throw Object.assign(new Error('ENOSPC injected'), { code: 'ENOSPC' });
    }) as any);

    let result: any;
    try {
      result = await service.applyConfig({
        version: 'latest', machineId: 'test-machine',
        targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
      });
    } finally {
      linkSpy.mockRestore();
      copySpy.mockRestore();
    }

    expect(result.errors.some((e: string) => e.includes('ENOSPC injected'))).toBe(true);
    // Ni un reste de copie (le rollback l'épargnerait, son sha256 ≠ l'intention),
    // ni un fichier temporaire, et le create-only reste REJOUABLE.
    expect(existsSync(join(workspaceDir, 'a.md'))).toBe(false);
    expect(readdirSync(workspaceDir).filter(n => n.includes('.roosync-wt-tmp-'))).toEqual([]);
    const retry = await service.applyConfig({
      version: 'latest', machineId: 'test-machine',
      targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
    });
    expect(retry.errors).toEqual([]);
    expect(readFileSync(join(workspaceDir, 'a.md'), 'utf-8')).toBe('A\n');
  });

  it('si le retrait de la destination partielle échoue, il est signalé sans masquer l’ENOSPC', async () => {
    publishWorkspaceTemplatePackage({ 'workspace-template/a.md': 'A\n' });

    const realUnlink = fsPromises.unlink.bind(fsPromises);
    const linkSpy = vi.spyOn(fsPromises, 'link').mockRejectedValue(Object.assign(new Error('EPERM injected'), { code: 'EPERM' }));
    const copySpy = vi.spyOn(fsPromises, 'copyFile').mockImplementation((async (src: any, dest: any) => {
      await fsPromises.writeFile(dest, 'PARTIAL');
      throw Object.assign(new Error('ENOSPC injected'), { code: 'ENOSPC' });
    }) as any);
    const unlinkSpy = vi.spyOn(fsPromises, 'unlink').mockImplementation(((file: any) => {
      if (String(file).includes('.roosync-wt-tmp-')) return realUnlink(file);
      return Promise.reject(Object.assign(new Error('EBUSY injected'), { code: 'EBUSY' }));
    }) as any);

    let result: any;
    try {
      result = await service.applyConfig({
        version: 'latest', machineId: 'test-machine',
        targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
      });
    } finally {
      linkSpy.mockRestore();
      copySpy.mockRestore();
      unlinkSpy.mockRestore();
    }

    // La cause d'origine reste lisible, et l'échec de retrait est RAPPORTÉ (pas
    // absorbé) — c'est l'état où un reste existe réellement sur disque.
    expect(result.errors.some((e: string) => e.includes('ENOSPC injected'))).toBe(true);
    expect(result.errors.some((e: string) => e.includes('destination partielle non retirée'))).toBe(true);
  });

  it('un journal pré-existant illisible est signalé puis réécrit, sans bloquer l’apply', async () => {
    publishWorkspaceTemplatePackage({
      'workspace-template/a.md': 'A\n',
      'workspace-template/sub/b.md': 'B\n',
      'workspace-template/sub/deep/c.md': 'C\n',
    });

    // La relecture du journal à CHAQUE flush passe par cette branche : un journal
    // illisible est signalé, puis réécrit valide par le flush qui l'a lu — le
    // flush suivant le relit donc sans erreur. Exactement un signalement = la
    // branche a été exercée ET n'a pas répété par fichier.
    const journalPath = createHash('sha256').update(wsReal).digest('hex').slice(0, 16);
    writeFileSync(join(journalDir, `${journalPath}.json`), 'NOT JSON', 'utf-8');

    const result = await service.applyConfig({
      version: 'latest', machineId: 'test-machine',
      targets: ['workspace-template'], workspacePath: workspaceDir, dryRun: false,
    });

    expect(result.workspaceTemplate!.created).toHaveLength(3);
    expect(result.errors.filter((e: string) => e.includes('journal existant illisible'))).toHaveLength(1);
    const journal = JSON.parse(readFileSync(result.workspaceTemplate!.journalPath, 'utf-8'));
    expect([...journal.files].sort()).toEqual([join(wsReal, 'a.md'), join(wsReal, 'sub', 'b.md'), join(wsReal, 'sub', 'deep', 'c.md')].sort());
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
