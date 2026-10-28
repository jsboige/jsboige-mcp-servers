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
 * La règle : une LIGNE de test qui porte « base temporaire + jeton d'unicité »
 * doit construire son chemin par `mkdtemp`/`mkdtempSync` (variantes sync et
 * fs/promises toutes deux acceptées), et le test nettoie derrière lui. Le
 * patron de référence est NarrativeContextBuilderService.test.ts l.62-118 :
 * mkdtempSync + registre tempDirs vidé par rmSync en afterEach.
 *
 * Exemption PAR LIGNE, jamais par fichier (revue ai-01, W2) : un appel
 * `mkdtemp(...)` légitime ailleurs dans le fichier ne dispense pas une ligne
 * fautive. Sinon, ajouter un simple mkdtempSync à un fichier de la baseline
 * suffirait à rendre son entrée « périmée », à la faire supprimer — et le
 * fautif survivant deviendrait invisible pour toujours. Exactement ce que le
 * ratchet promet d'empêcher.
 *
 * Les COMMENTAIRES sont ignorés des DEUX côtés (revue ai-01, W1) : un
 * commentaire contenant `mkdtemp(` n'exempte rien, et un chemin fautif
 * commenté n'est pas une offense (il n'écrit rien). `stripComments` est un
 * scanneur à états (chaînes ', ", gabarits ` avec `${…}`), pas une regex :
 * une regex couperait à `//` dans une URL ou un gabarit.
 *
 * Ratchet : l'état actuel de l'arbre est gelé dans BASELINE. La garde échoue
 * dans les DEUX sens :
 *   - un NOUVEAU fautif (ligne fautive non exemptée, fichier hors baseline)
 *     => rouge, fichier ET lignes nommés ;
 *   - une entrée PÉRIMÉE (fichier de la baseline corrigé ou supprimé) =>
 *     rouge : retirez-la, la baseline ne peut que rétrécir.
 * Un litéral `/tmp/x` simple (fixture sans jeton d'unicité) reste permis :
 * les fixtures de chaînes n'écrivent rien.
 *
 * FORMES NON DÉTECTÉES (limites assumées, revue ai-01 W3) — un jeton
 * d'unicité autre que les quatre ci-dessous, ou une base qui n'apparaît pas
 * sur la ligne de concaténation, passent au travers :
 *   - `crypto.randomBytes(n).toString('hex')` comme jeton d'unicité ;
 *   - `Date.now` SANS parenthèses (référence, pas appel) ;
 *   - une base prise de `process.env.TEMP` / `process.env.TMPDIR` ;
 *   - la forme en DEUX lignes `const base = os.tmpdir();` puis
 *     `join(base, randomUUID())` — aucune des deux lignes ne porte
 *     base+jeton ensemble (la continuité d'appel mkdtemp, elle, est gérée) ;
 *   - un gabarit contenant `//` ou une regex littérale contenant `/*`
 *     peuvent tromper le scanneur de commentaires (cas non rencontré ici).
 * Étendre le prédicat à ces formes demanderait un vrai parseur TypeScript.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUARD_FILENAME = 'temp-path-guard.test.ts';

/** Base temporaire faite main : litéral /tmp/ (racine du lecteur sous Windows) ou tmpdir(). */
const TEMP_BASE = /\/tmp\/|tmpdir\(/;
/** Jetons d'unicité auto-inventés — l'unique sanctionné est mkdtemp lui-même. */
const UNIQUENESS_TOKEN = /Date\.now\(\)|randomUUID|Math\.random\(\)|process\.pid/;
/** Un APPEL réel de mkdtemp/mkdtempSync (sync et fs/promises). */
const MKDTEMP_CALL = /mkdtemp\w*\s*\(/;

/**
 * Retire les commentaires `//` et `/* *\/` du source, en préservant les
 * numéros de ligne (les retours à la ligne des blocs sont conservés) et le
 * contenu des chaînes et gabarits (un `/tmp/` dans un gabarit est un vrai
 * chemin). Scan à états : aperçu simple, pas un parseur — les limites sont
 * énumérées dans l'en-tête du fichier.
 *
 * `blankStrings` (revue ms#1547) : remplace le CONTENU des chaînes et gabarits
 * par des espaces (guillemets et `${…}` conservés, longueur et lignes
 * identiques). Pour `parenBalance` : une parenthèse DANS un littéral
 * (`'str('`) ne doit pas compter — sans cela, la ligne suivante était
 * exemptée comme « continuation » d'un appel qui n'en était pas un.
 */
function stripComments(source: string, opts?: { blankStrings?: boolean }): string {
    const blank = opts?.blankStrings === true;
    let out = '';
    let i = 0;
    const n = source.length;
    /** Profondeur d'accolades au moment où un `${` a ouvert une expression de gabarit. */
    const templateStack: number[] = [];
    let braceDepth = 0;
    let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';

    while (i < n) {
        const c = source[i];
        const next = i + 1 < n ? source[i + 1] : '';

        if (state === 'code') {
            if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
            if (c === '/' && next === '*') { state = 'block'; i += 2; out += ' '; continue; }
            if (c === "'") { state = 'single'; out += c; i++; continue; }
            if (c === '"') { state = 'double'; out += c; i++; continue; }
            if (c === '`') { state = 'template'; out += c; i++; continue; }
            if (c === '{') {
                braceDepth++;
            } else if (c === '}') {
                braceDepth--;
                if (templateStack.length > 0 && braceDepth === templateStack[templateStack.length - 1]) {
                    templateStack.pop();
                    state = 'template';
                }
            }
            out += c; i++; continue;
        }

        if (state === 'line') {
            if (c === '\n') { state = 'code'; out += c; }
            i++; continue;
        }

        if (state === 'block') {
            if (c === '*' && next === '/') { state = 'code'; i += 2; out += ' '; continue; }
            if (c === '\n') out += c;
            i++; continue;
        }

        if (state === 'single' || state === 'double') {
            const quote = state === 'single' ? "'" : '"';
            // Échappement : le `next` reste VERBATIM même en blanking — un
            // `\<newline>` (continuation de ligne) doit garder son retour à la
            // ligne, sinon les deux passes n'ont plus le même nombre de lignes.
            if (c === '\\') { out += (blank ? ' ' : c) + next; i += 2; continue; }
            if (c === quote) state = 'code';
            // Jamais blanker un '\n' (chaîne non fermée sur la ligne) : les deux
            // passes doivent garder le MÊME nombre de lignes.
            out += blank && c !== quote && c !== '\n' ? ' ' : c; i++; continue;
        }

        // state === 'template' — contenu verbatim (un chemin peut y vivre).
        if (c === '\\') { out += (blank ? ' ' : c) + next; i += 2; continue; }
        if (c === '`') { state = 'code'; out += c; i++; continue; }
        // `${` consomme une accolade : sans le `++`, le `}` fermant décrémentait
        // sous la valeur poussée, le pop ne se déclenchait jamais et le scanner
        // restait en état code — le reste du gabarit était alors traité comme du
        // code (parenthèses comptées, contenu non blanké).
        if (c === '$' && next === '{') { templateStack.push(braceDepth); braceDepth++; state = 'code'; out += '${'; i += 2; continue; }
        out += blank && c !== '\n' ? ' ' : c; i++;
    }
    return out;
}

/** Solde des parenthèses ouvrantes/fermantes d'un fragment (aperçu, pas un parseur). */
function parenBalance(text: string): number {
    let depth = 0;
    for (const ch of text) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
    }
    return depth;
}

/**
 * Numéros de ligne fautifs (1-based). Une ligne est exemptée si ELLE porte un
 * appel mkdtemp, ou si elle est la CONTINUATION d'un appel mkdtemp commencé
 * sur une ligne précédente (forme multi-ligne légitime). Commentaires ignorés
 * des deux côtés.
 */
function offendingLines(source: string): number[] {
    const lines = stripComments(source).split('\n');
    // Revue ms#1547 : le solde de parenthèses se calcule sur le source sans le
    // CONTENU des chaînes — une `'('` dans un littéral n'ouvre rien. Les
    // détections (base, jeton, appel) restent sur `lines` : les chemins fautifs
    // vivent précisément dans ces chaînes.
    const linesNoStrings = stripComments(source, { blankStrings: true }).split('\n');
    const offenders: number[] = [];
    let openCallDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNoStrings = linesNoStrings[i];
        const continuesCall = openCallDepth > 0;
        const callAt = line.search(MKDTEMP_CALL);

        if (continuesCall) {
            openCallDepth = Math.max(0, openCallDepth + parenBalance(lineNoStrings));
        } else if (callAt >= 0) {
            openCallDepth = Math.max(0, parenBalance(lineNoStrings.slice(callAt)));
        }

        const exempt = continuesCall || callAt >= 0;
        if (!exempt && TEMP_BASE.test(line) && UNIQUENESS_TOKEN.test(line)) offenders.push(i + 1);
    }
    return offenders;
}

/** Fautif si au moins une ligne non exemptée porte base + jeton d'unicité. */
function isViolation(content: string): boolean {
    return offendingLines(content).length > 0;
}

/**
 * Fautifs gelés, re-mesurés sous l'exemption PAR LIGNE (revue ai-01 W2) : la
 * liste précédente (49) était calculée sous une exemption PAR FICHIER, qui
 * masquait les lignes fautives des fichiers appelant par ailleurs mkdtemp.
 * La mesure honnête est un SUR-ENSEMBLE — le ratchet ne rétrécit pas ici, il
 * corrige un angle mort. Chaque entrée doit encore porter au moins une ligne
 * fautive : corriger un fichier impose de retirer son entrée.
 */
const BASELINE = new Set([
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
    'src/services/__tests__/MessageManager.twin-guard.test.ts',
    'src/services/__tests__/RooSettingsService-zoo.test.ts',
    'src/services/__tests__/RooSyncService.test.ts',
    'src/services/roosync/__tests__/AttachmentManager.coverage.test.ts',
    'src/services/roosync/__tests__/AttachmentManager.targeted.test.ts',
    'src/services/roosync/__tests__/AttachmentManager.test.ts',
    'src/services/roosync/__tests__/AttachmentManager.timeout.test.ts',
    'src/services/unified-store/__tests__/roosync-attachment-pg.test.ts',
    'src/services/unified-store/__tests__/roosync-channel-dual-write.test.ts',
    'src/services/unified-store/__tests__/roosync-channel-read.test.ts',
    'src/services/unified-store/__tests__/roosync-channel-write.test.ts',
    'src/tools/__tests__/export-tree-md.tool.test.ts',
    'src/tools/__tests__/view-conversation-tree-unified-store.test.ts',
    'src/tools/roosync/__tests__/attachments-store-absent-pg.test.ts',
    'src/tools/roosync/__tests__/config.test.ts',
    'src/tools/roosync/__tests__/dashboard-empty-key-guard.test.ts',
    'src/tools/roosync/__tests__/dashboard-list-pg.test.ts',
    'src/tools/roosync/__tests__/dashboard-merge.test.ts',
    'src/tools/roosync/__tests__/dashboard-retirement.test.ts',
    'src/tools/roosync/__tests__/dashboard-stale-copy-append.test.ts',
    'src/tools/roosync/__tests__/dashboard-store-absent-pg.test.ts',
    'src/tools/roosync/__tests__/fail-closed-store.test.ts',
    'src/tools/roosync/__tests__/intercom-append.test.ts',
    'src/tools/roosync/__tests__/read-attachments-store-absent-pg.test.ts',
    'src/tools/roosync/__tests__/read-store-absent-pg.test.ts',
    'src/utils/__tests__/cache-manager-disk.test.ts',
    'src/utils/__tests__/claude-storage-detector.coverage.test.ts',
    'src/utils/__tests__/claude-storage-detector.test.ts',
    'src/utils/__tests__/extension-paths.test.ts',
    'tests/e2e/roosync-compare-validate-apply.test.ts',
    'tests/e2e/roosync-conflict-management.test.ts',
    'tests/e2e/roosync-conflict-resolution.test.ts',
    // Les 2 suivants sont l'angle mort W2 MESURÉ : chacun appelle mkdtempSync
    // légitimement (l.170/261 et l.161) — l'ancienne exemption par FICHIER les
    // masquait entièrement. Leurs lignes faites main sont réelles.
    'tests/unit/archive-orphan-mention-notifications.test.ts',
    'tests/unit/services/ConfigService.coverage.test.ts',
    'tests/unit/services/hierarchy-reconstruction-engine.test.ts',
    'tests/unit/tools/get-mcp-best-practices.test.ts',
    'tests/unit/tools/mock-parity.test.ts',
    'tests/unit/tools/roosync/inventory.test.ts',
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

    it('W1 — un commentaire contenant un APPEL `mkdtemp(` ne dispense pas la ligne fautive', () => {
        const sneakyLine = '// TODO: use mkdtemp(join(tmpdir(), p)) here\nconst d = join(tmpdir(), `sneaky-${randomUUID()}`);';
        expect(isViolation(sneakyLine)).toBe(true);
    });

    it('W1 — même chose en commentaire de bloc `/* ... */`', () => {
        const sneakyBlock = '/* mkdtemp(path.join(tmpdir(), "x")) ferait mieux */\nconst d = join(tmpdir(), `blk-${Date.now()}`);';
        expect(isViolation(sneakyBlock)).toBe(true);
    });

    it('un chemin fautif COMMENTÉ n\'est pas une offense (il n\'écrit rien)', () => {
        const commented = '// const legacy = join(tmpdir(), `old-${Date.now()}`);\nconst stamp = Date.now();';
        expect(isViolation(commented)).toBe(false);
    });

    it('W2 — un appel mkdtemp légitime AILLEURS ne dispense pas la ligne fautive du même fichier', () => {
        const mixed = "const clean = mkdtempSync(join(tmpdir(), 'ok-'));\nconst bad = join(tmpdir(), `bad-${randomUUID()}`);";
        expect(isViolation(mixed)).toBe(true);
    });

    it('une continuation multi-ligne d\'un appel mkdtemp est dispensée', () => {
        const multiline = 'const d = await mkdtemp(\n  join(tmpdir(), `cont-${Date.now()}`)\n);';
        expect(isViolation(multiline)).toBe(false);
    });

    it('W4 (revue ms#1547) — une parenthèse DANS une chaîne de l\'appel mkdtemp ne crée plus de continuation fantôme', () => {
        // La fuite : le littéral `'x('` laissait le solde de l'appel à +1 après
        // sa dernière vraie parenthèse fermante — la ligne FAUTIVE suivante
        // était exemptée comme « continuation » d'un appel déjà refermé.
        const sneaky = "const d = await mkdtemp(join(tmpdir(), 'x('));\nconst bad = join(tmpdir(), `ghost-${randomUUID()}`);";
        expect(isViolation(sneaky)).toBe(true);
    });

    it('W4 (revue ms#1547) — une parenthèse dans un GABARIT de la continuation non plus', () => {
        // Forme multi-ligne de la même fuite : le ` (unclosed` du gabarit
        // laisse le solde à 1 après la fermeture réelle de l'appel.
        const sneakyTpl = 'const d = await mkdtemp(\n  join(tmpdir(), `staging-${Date.now()} (unclosed`)\n);\nconst bad = join(tmpdir(), `ghost-${randomUUID()}`);';
        expect(isViolation(sneakyTpl)).toBe(true);
    });

    it('jeton d\'unicité seul, sans base temporaire sur la ligne : permis', () => {
        expect(isViolation('mockStatSync.mockReturnValue({ size: 0, mtimeMs: Date.now() } as any);')).toBe(false);
    });
});

describe('ms#1539 — ratchet : aucun nouveau fautif, aucune entrée de baseline périmée', () => {
    it('l\'arbre src/ et tests/ ne gagne pas de chemin temporaire fait main', () => {
        const files = listTestFiles().filter((f) => basename(f) !== GUARD_FILENAME);
        expect(files.length).toBeGreaterThan(500); // la marche elle-même : un scan vide n'est pas un PASS
        const offending = files.filter((f) => isViolation(readFileSync(join(SERVER_ROOT, f), 'utf8')));
        const offenders = offending
            .filter((f) => !BASELINE.has(f))
            .map((f) => `${f} (lignes ${offendingLines(readFileSync(join(SERVER_ROOT, f), 'utf8')).join(', ')})`);
        expect(offenders, 'NOUVEAU chemin temporaire fait main (mkdtemp obligatoire — patron : NarrativeContextBuilderService.test.ts l.62-118)').toEqual([]);

        const stale = [...BASELINE].filter((f) => !offending.includes(f));
        expect(stale, 'Entrées de baseline périmées (fichier corrigé ou supprimé) : retirez-les de BASELINE — elle ne peut que rétrécir').toEqual([]);
    });
});
