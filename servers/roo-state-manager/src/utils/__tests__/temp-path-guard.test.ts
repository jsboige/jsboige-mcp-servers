/**
 * ms#1539 — garde anti-récidive des chemins temporaires faits main (ratchet).
 *
 * Incident fondateur : 33 818 répertoires `test-logs-*` légués sous la racine
 * du lecteur (un litéral `/tmp/...` sous Windows écrit à la racine de `D:`),
 * plus quatre familles dormantes (`roosync-conflict-integration-*`, etc.).
 * Tous nés du même geste : un test qui fabrique SON chemin temporaire unique
 * en concaténant une base (`/tmp/` ou `tmpdir()`) avec un jeton d'unicité
 * (`Date.now()`, `randomUUID`, `Math.random()`, `process.pid`) — puis ne le
 * nettoie pas toujours. Sur Windows, `os.tmpdir()` renvoie le vrai temp OS
 * mais `/tmp/` pointe la racine du lecteur courant : les deux fuient.
 *
 * La règle : un fichier de test qui porte la signature « base temporaire +
 * jeton d'unicité sur la même ligne » doit passer par `mkdtemp`/`mkdtempSync`
 * (variantes sync et fs/promises toutes deux acceptées) et nettoyer derrière
 * lui. Le patron de référence est NarrativeContextBuilderService.test.ts
 * l.62-118 : mkdtempSync + registre tempDirs vidé par rmSync en afterEach.
 *
 * Ratchet : l'état actuel de l'arbre (49 fichiers fautifs — src/ ET tests/,
 * y compris tests/e2e où vivaient les créateurs des familles mortes — mesuré
 * au commit 089be4cb à l'ouverture de ms#1539) est gelé dans BASELINE. La
 * garde échoue dans les DEUX sens :
 *   - un NOUVEAU fautif (signature sans mkdtemp, hors baseline) => rouge ;
 *   - une entrée PÉRIMÉE (fichier de la baseline corrigé ou supprimé) =>
 *     rouge : retirez-la, la baseline ne peut que rétrécir.
 * Un litéral `/tmp/x` simple (fixture sans jeton d'unicité) reste permis :
 * les fixtures de chaînes n'écrivent rien.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUARD_FILENAME = 'temp-path-guard.test.ts';

/** Base temporaire faite main : litéral /tmp/ (racine du lecteur sous Windows) ou tmpdir(). */
const TEMP_BASE = /\/tmp\/|tmpdir\(/;
/** Jetons d'unicité auto-inventés — l'unique sanctioned est mkdtemp lui-même. */
const UNIQUENESS_TOKEN = /Date\.now\(\)|randomUUID|Math\.random\(\)|process\.pid/;
/**
 * Exemption : un APPEL réel de mkdtemp/mkdtempSync (le mot seul dans un
 * commentaire ne dispense de rien — mesuré à la première mutation de cette
 * garde, où le commentaire du fichier injecté l'exonérait à tort).
 */
const SANCTIONED_MKDTEMP_CALL = /mkdtemp\w*\s*\(/;

/**
 * Fautif si une ligne porte base + jeton d'unicité et que le fichier
 * n'appelle mkdtemp nulle part (sync ni promesses).
 */
function isViolation(content: string): boolean {
    if (SANCTIONED_MKDTEMP_CALL.test(content)) return false;
    return content.split('\n').some((line) => TEMP_BASE.test(line) && UNIQUENESS_TOKEN.test(line));
}

/**
 * Fautifs gelés à l'ouverture (commit 089be4cb, PR ms#1539). Chaque entrée
 * doit encore matcher le prédicat : corriger un fichier impose de retirer
 * son entrée — c'est le mécanisme qui fait rétrécir cette liste.
 */
const BASELINE = new Set([
    'src/services/roosync/__tests__/AttachmentManager.coverage.test.ts',
    'src/services/roosync/__tests__/AttachmentManager.targeted.test.ts',
    'src/services/roosync/__tests__/AttachmentManager.test.ts',
    'src/services/roosync/__tests__/AttachmentManager.timeout.test.ts',
    'src/services/unified-store/__tests__/roosync-attachment-pg.test.ts',
    'src/services/unified-store/__tests__/roosync-channel-dual-write.test.ts',
    'src/services/unified-store/__tests__/roosync-channel-read.test.ts',
    'src/services/unified-store/__tests__/roosync-channel-write.test.ts',
    'src/services/__tests__/ConfigSharingService.test.ts',
    'src/services/__tests__/MessageManager.bulk-pool-parity.test.ts',
    'src/services/__tests__/MessageManager.cache-revalidation.test.ts',
    'src/services/__tests__/MessageManager.explicit-starvation-warn.coverage.test.ts',
    'src/services/__tests__/MessageManager.machine-wide-read.test.ts',
    'src/services/__tests__/MessageManager.partial-cache-merge.coverage.test.ts',
    'src/services/__tests__/MessageManager.pg-fallback-stale-serve.coverage.test.ts',
    'src/services/__tests__/MessageManager.pool-reserve.coverage.test.ts',
    'src/services/__tests__/MessageManager.recency-embedded-only.coverage.test.ts',
    'src/services/__tests__/MessageManager.swr.test.ts',
    'src/services/__tests__/MessageManager.timeout.test.ts',
    'src/services/__tests__/RooSettingsService-zoo.test.ts',
    'src/services/__tests__/RooSyncService.test.ts',
    'src/tools/roosync/__tests__/config.test.ts',
    'src/tools/roosync/__tests__/dashboard-store-absent-pg.test.ts',
    'src/tools/roosync/__tests__/read-store-absent-pg.test.ts',
    'src/tools/__tests__/export-tree-md.tool.test.ts',
    'src/utils/__tests__/cache-manager-disk.test.ts',
    'src/utils/__tests__/claude-storage-detector.coverage.test.ts',
    'src/utils/__tests__/claude-storage-detector.test.ts',
    'src/utils/__tests__/extension-paths.test.ts',
    // tests/e2e + tests/unit — découverts par la garde elle-même à sa première
    // exécution (scan bash antérieur limité à src/ et piégé par [^\n] en ERE) ;
    // tests/e2e porte les créateurs historiques des familles mortes.
    'src/services/__tests__/MessageManager.twin-guard.test.ts',
    'src/tools/roosync/__tests__/attachments-store-absent-pg.test.ts',
    'src/tools/roosync/__tests__/dashboard-empty-key-guard.test.ts',
    'src/tools/roosync/__tests__/dashboard-list-pg.test.ts',
    'src/tools/roosync/__tests__/dashboard-merge.test.ts',
    'src/tools/roosync/__tests__/dashboard-retirement.test.ts',
    'src/tools/roosync/__tests__/dashboard-stale-copy-append.test.ts',
    'src/tools/roosync/__tests__/fail-closed-store.test.ts',
    'src/tools/roosync/__tests__/intercom-append.test.ts',
    'src/tools/roosync/__tests__/read-attachments-store-absent-pg.test.ts',
    'src/tools/__tests__/view-conversation-tree-unified-store.test.ts',
    'tests/e2e/roosync-compare-validate-apply.test.ts',
    'tests/e2e/roosync-conflict-management.test.ts',
    'tests/e2e/roosync-conflict-resolution.test.ts',
    'tests/unit/services/ConfigService.coverage.test.ts',
    'tests/unit/services/hierarchy-reconstruction-engine.test.ts',
    'tests/unit/tools/get-mcp-best-practices.test.ts',
    'tests/unit/tools/mock-parity.test.ts',
    'tests/unit/utils/shared-state-path.test.ts',
    'tests/unit/workspace-filtering-diagnosis.test.ts',
]);

/** Marche les racines de tests first-party et collecte les *.test.ts (chemins relatifs au serveur). */
function listTestFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            // Défensif : jamais de vendor ni d'artefacts dans le périmètre de la garde.
            if (entry.isDirectory() && ['node_modules', 'coverage', '_archives', 'backups'].includes(entry.name)) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(relative(SERVER_ROOT, full).replace(/\\/g, '/'));
        }
    };
    walk(join(SERVER_ROOT, 'src'));
    walk(join(SERVER_ROOT, 'tests'));
    return out;
}

describe('ms#1539 — prédicat : chemin temporaire unique fait main', () => {
    it('template literal /tmp/ + Date.now() (la signature test-logs) est fautif', () => {
        expect(isViolation("const d = `/tmp/cache-test-${Date.now()}`;\nwriteFileSync(join(d, 'x'), '');")).toBe(true);
    });

    it('join(tmpdir(), `prefix-${randomUUID()}`) est fautif (famille mm-swr)', () => {
        expect(isViolation('const dir = join(tmpdir(), `mm-swr-${randomUUID()}`);')).toBe(true);
    });

    it('tmpdir() + process.pid sur la même ligne est fautif', () => {
        expect(isViolation('const d = path.join(os.tmpdir(), `f-${process.pid}`);')).toBe(true);
    });

    it('un fichier qui utilise mkdtempSync (patron de référence) est dispensé', () => {
        const safe = "import { mkdtempSync } from 'fs';\nconst stamp = Date.now();\nconst d = mkdtempSync(join(tmpdir(), 'narrative-x-'));";
        expect(isViolation(safe)).toBe(false);
    });

    it('un fichier qui utilise mkdtemp de fs/promises est dispensé (variante async)', () => {
        const safe = "import { mkdtemp } from 'fs/promises';\nconst old = new Date(Date.now() - 20 * 60_000);\nconst d = await mkdtemp(path.join(os.tmpdir(), 'tags-'));";
        expect(isViolation(safe)).toBe(false);
    });

    it('un litéral /tmp/x sans jeton d\'unicité (fixture de chaîne) reste permis', () => {
        expect(isViolation("const error = new InvalidStoragePathError('/tmp/nope');")).toBe(false);
        expect(isViolation("parameters: { path: '/tmp/test.ts' },")).toBe(false);
    });

    it('une simple mention de mkdtemp en commentaire ne dispense pas (leçon de la 1re mutation de cette garde)', () => {
        const sneaky = '// nettoie via mkdtemp ailleurs\nconst d = join(tmpdir(), `sneaky-${randomUUID()}`);';
        expect(isViolation(sneaky)).toBe(true);
    });

    it('jeton d\'unicité seul, sans base temporaire sur la ligne : permis', () => {
        expect(isViolation('mockStatSync.mockReturnValue({ size: 0, mtimeMs: Date.now() } as any);')).toBe(false);
    });
});

describe('ms#1539 — ratchet : aucun nouveau fautif, aucune entrée de baseline périmée', () => {
    it('l\'arbre src/ ne gagne pas de chemin temporaire fait main', () => {
        const files = listTestFiles().filter((f) => basename(f) !== GUARD_FILENAME);
        expect(files.length).toBeGreaterThan(500); // la marche elle-même : un scan vide n'est pas un PASS
        const offenders = files
            .filter((f) => isViolation(readFileSync(join(SERVER_ROOT, f), 'utf8')))
            .filter((f) => !BASELINE.has(f));
        expect(offenders, 'NOUVEAU chemin temporaire fait main (mkdtemp obligatoire — patron : NarrativeContextBuilderService.test.ts l.62-118)').toEqual([]);

        const stale = [...BASELINE].filter((f) => !files.includes(f) || !isViolation(readFileSync(join(SERVER_ROOT, f), 'utf8')));
        expect(stale, 'Entrées de baseline périmées (fichier corrigé ou supprimé) : retirez-les de BASELINE — elle ne peut que rétrécir').toEqual([]);
    });
});
