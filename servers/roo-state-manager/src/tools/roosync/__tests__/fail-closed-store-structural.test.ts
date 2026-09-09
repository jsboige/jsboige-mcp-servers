/**
 * #3459 — Test structurel anti-contournement (arbitrage ai-01, option b).
 *
 * Le helper `ensureStoreSubdir` (utils/shared-state-path.ts) ne devient la
 * propriété du système que s'il est LE SEUL chemin possible. Rien n'empêche
 * un `mkdirSync(join(sharedPath, ...))` écrit demain à côté du helper — par
 * un agent qui ne le connaît pas. Ce test rend ce contournement VISIBLE :
 * il échoue dès qu'un mkdir primitif prend un chemin dérivé de la racine du
 * store en dehors du helper.
 *
 * « Un grep structurel sur les sources suffit, il n'a pas besoin d'être
 * élégant. C'est ce test, pas le helper, qui porte la propriété dans le
 * temps. » — arbitrage #3459.
 *
 * Deux voies de détection (review PR #1116, 07/09) :
 *
 * 1. DÉRIVATION DIRECTE — un mkdir primitif dont la ligne ou sa fenêtre de
 *    4 lignes mentionne un jeton du store. Couvre le contournement accidentel
 *    local (`const d = join(sharedPath, …); mkdirSync(d)`).
 *
 * 2. DÉRIVATION PAR PARAMÈTRE (AST) — le trou qui a échappé à la voie 1 :
 *    le mkdir vit dans une fonction qui reçoit le chemin en PARAMÈTRE
 *    (aucun jeton dans sa fenêtre), et le site d'appel passe une variable
 *    dérivée du store (`createBackup(files, backupDir)` où
 *    `backupDir = join(config.sharedPath, …)`). Les deux moitiés prises
 *    isolément sont invisibles ; seule la corrélation les attrape.
 *
 *    Précision par SLOT : la voie 2 n'indexe pas « toute fonction contenant
 *    un mkdir récursif » aveuglément — elle résout QUELS paramètres (ou
 *    propriétés du paramètre-options, ou locaux dérivés en un bond)
 *    alimentent le chemin du mkdir récursif, et ne vérifie QUE ces slots
 *    aux sites d'appel. Une fonction peut légitimement recevoir un chemin
 *    du store pour LIRE (ex. EnvRotationService.apply lit le secret dans le
 *    store et mkdir son targetEnvPath LOCAL) sans être signalée.
 *
 *    Le scope de la voie 2 est volontairement le mkdir récursif : un mkdir
 *    NON récursif sur un chemin store ne peut pas RECRÉER la racine absente
 *    (il meurt en ENOENT — fail-closed par nature) ; il viole au plus la
 *    propriété « le helper possède toute création », sans rouvrir le trou
 *    #3459. La propriété portée ici est la non-re-création de la racine.
 *
 * CONTRÔLES NÉGATIFS COMMITTÉS (review pt 3) : les mutations qui doivent
 * rougir vivent en snippets synthétiques, et des `it` dédiés prouvent que
 * le garde mord — y compris sur la forme exacte par paramètre — et qu'il
 * ne mord pas sur les chemins non-store. Une mesure jetée avant push ne
 * prouve rien six mois plus tard ; un contrôle committé, si.
 *
 * Fichiers exclus :
 * - utils/shared-state-path.ts : le helper lui-même (son mkdirSync EST le
 *   chemin sanctionné — et son nom est exonéré à la voie 2) ;
 * - tools/roosync/roosync_init.ts : l'initialiseur — créer la racine du
 *   store est sa fonction déclarée (`roosync_init` sur store absent).
 *
 * @module tests/roosync/fail-closed-store-structural
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import * as ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const SRC_ROOT = join(__dirname, '..', '..', '..');

const EXCLUDED = new Set([
  join('utils', 'shared-state-path.ts'),
  join('tools', 'roosync', 'roosync_init.ts'),
]);

/** Le writer sanctionné — exonéré de la voie 2 par nom, pas seulement par fichier. */
const SANCTIONED_WRITER = 'ensureStoreSubdir';

/** Primitifs mkdir — le point de départ de l'audit « par le primitif ». */
const MKDIR_RE = /(?:mkdirSync|\bmkdir)\s*\(/;

/**
 * Jetons dont la présence près d'un mkdir trahit une dérivation depuis la
 * racine du store (accès directs ET variables dérivées : accessors
 * dashboards/archive, attachments, messages).
 */
const SHARED_TOKEN_RE =
  /sharedPath|sharedStatePath|getSharedStatePath|tryGetSharedStatePath|getDashboardsDir|getArchiveDir|attachmentsPath|messagesPath/;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'build') continue;
      out.push(...listSourceFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

// ─────────────────── API du scanner (réutilisée par les contrôles) ───────────────────

export interface SourceSlice {
  rel: string;
  content: string;
}

export interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

/**
 * Un « slot » d'entrée d'une fonction indexée : la position (paramètre
 * positionnel, ou propriété d'un paramètre-options) qui alimente le chemin
 * de son mkdir récursif.
 */
type MkdirSlot =
  | { kind: 'param'; index: number }
  | { kind: 'prop'; ownerIndex: number; propName: string };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** mkdir/mkdirSync avec `{ recursive: true }` — le seul capable de RECRÉER la racine. */
function isRecursiveMkdir(call: ts.CallExpression): boolean {
  const name = calleeName(call.expression);
  if (!name || (name !== 'mkdirSync' && name !== 'mkdir')) return false;
  const opts = call.arguments[1];
  return (
    !!opts &&
    ts.isObjectLiteralExpression(opts) &&
    opts.properties.some(
      p =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === 'recursive' &&
        p.initializer.kind === ts.SyntaxKind.TrueKeyword
    )
  );
}

/** Fonction nommée (declaration, méthode, const-arrow) — l'unité indexable de la voie 2. */
interface NamedFunction {
  name: string;
  fn: ts.FunctionLikeDeclaration;
}

function asNamedFunction(node: ts.Node): NamedFunction | null {
  if (ts.isFunctionDeclaration(node) && node.name) return { name: node.name.text, fn: node };
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return { name: node.name.text, fn: node };
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))
  ) {
    return { name: node.name.text, fn: node.initializer };
  }
  return null;
}

function collectIdentifierTexts(node: ts.Node): string[] {
  const out: string[] = [];
  if (ts.isIdentifier(node)) out.push(node.text);
  function visit(n: ts.Node): void {
    if (ts.isIdentifier(n)) out.push(n.text);
    n.forEachChild(visit);
  }
  node.forEachChild(visit);
  return out;
}

/** Un mkdir récursif dans `node`, sans traverser les fonctions nommées imbriquées (elles s'indexent seules). */
function findRecursiveMkdir(node: ts.Node): ts.CallExpression | null {
  if (ts.isCallExpression(node) && isRecursiveMkdir(node)) return node;
  let found: ts.CallExpression | null = null;
  node.forEachChild(child => {
    if (found || asNamedFunction(child)) return;
    found = findRecursiveMkdir(child) ?? found;
  });
  return found;
}

function slotKey(s: MkdirSlot): string {
  return s.kind === 'param' ? `p${s.index}` : `o${s.ownerIndex}.${s.propName}`;
}

/**
 * Résout quels slots d'entrée de `fn` alimentent le chemin de son mkdir
 * récursif : paramètres directs, propriétés de paramètre-options (via
 * déstructuration ou `param.prop`), et locaux dérivés en un bond (fixpoint
 * borné à 3 tours). Ambigu (deux sources) → non résolu → non signalé.
 */
function resolveMkdirSlots(fn: ts.FunctionLikeDeclaration, mkdirCall: ts.CallExpression): MkdirSlot[] {
  const bindings = new Map<string, MkdirSlot>();
  for (let i = 0; i < fn.parameters.length; i++) {
    const p = fn.parameters[i];
    if (ts.isIdentifier(p.name)) bindings.set(p.name.text, { kind: 'param', index: i });
    else if (ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) {
        if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
          bindings.set(el.name.text, { kind: 'prop', ownerIndex: i, propName: el.name.text });
        }
      }
    }
  }

  const body = fn.body ?? fn;
  for (let round = 0; round < 3; round++) {
    let changed = false;
    function walkDecls(n: ts.Node): void {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && !bindings.has(n.name.text)) {
        const init = n.initializer;
        let slot: MkdirSlot | null = null;
        if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression)) {
          const owner = bindings.get(init.expression.text);
          if (owner?.kind === 'param') slot = { kind: 'prop', ownerIndex: owner.index, propName: init.name.text };
        }
        if (!slot) {
          const refs = collectIdentifierTexts(init).filter(t => bindings.has(t));
          if (refs.length === 1) slot = bindings.get(refs[0]) ?? null;
        }
        if (slot) {
          bindings.set(n.name.text, slot);
          changed = true;
        }
      }
      if (asNamedFunction(n)) return; // ne pas traverser les fonctions imbriquées
      n.forEachChild(walkDecls);
    }
    body.forEachChild(walkDecls);
    if (!changed) break;
  }

  const slots = new Map<string, MkdirSlot>();
  for (const id of collectIdentifierTexts(mkdirCall.arguments[0])) {
    const s = bindings.get(id);
    if (s) slots.set(slotKey(s), s);
  }
  return [...slots.values()];
}

/** Voie 2, passe A : nom de fonction → slots alimentant son mkdir récursif. */
function indexRecursiveMkdirFunctions(rel: string, sf: ts.SourceFile, index: Map<string, MkdirSlot[]>): void {
  function walk(node: ts.Node): void {
    const named = asNamedFunction(node);
    if (named && named.name !== SANCTIONED_WRITER) {
      const mkdirCall = findRecursiveMkdir(named.fn.body ?? named.fn);
      if (mkdirCall) index.set(named.name, resolveMkdirSlots(named.fn, mkdirCall));
    }
    node.forEachChild(walk);
  }
  sf.forEachChild(walk);
}

/**
 * L'argument (ou la propriété d'argument) est-il dérivé de la racine du
 * store ? Soit directement (jeton dans son texte), soit via un identifiant
 * dont la déclaration — cherchée dans la fenêtre au-dessus de l'appel —
 * porte le jeton (déclaration + 2 lignes de suite, pour les initializers
 * multi-lignes ; un jeton d'une AUTRE déclaration de la fenêtre ne compte
 * pas).
 */
function argIsStoreDerived(arg: ts.Expression | undefined, callLine0: number, lines: string[], sf: ts.SourceFile): boolean {
  if (!arg) return false;
  if (SHARED_TOKEN_RE.test(arg.getText(sf))) return true;
  if (!ts.isIdentifier(arg)) return false;
  const declRe = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(arg.text)}\\s*=`);
  const from = Math.max(0, callLine0 - 4);
  for (let i = from; i <= callLine0; i++) {
    if (!declRe.test(lines[i] ?? '')) continue;
    const scope = lines.slice(i, Math.min(lines.length, i + 3)).join('\n');
    return SHARED_TOKEN_RE.test(scope);
  }
  return false;
}

/** Voie 2, passe B : site d'appel d'une fonction indexée recevant du store dans un slot mkdir. */
function scanParamDerivationCalls(
  rel: string,
  content: string,
  sf: ts.SourceFile,
  index: Map<string, MkdirSlot[]>
): Violation[] {
  const lines = content.split('\n');
  const out: Violation[] = [];

  function flag(call: ts.CallExpression, name: string, via: string): void {
    const line0 = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line;
    out.push({
      file: rel,
      line: line0 + 1,
      text: lines[line0]?.trim() ?? call.getText(sf),
      reason:
        `param-derivation: «${name}» fait un mkdir RÉCURSIF sur «${via}» et reçoit à ce slot un chemin ` +
        `dérivé de la racine du store — router le parent par ensureStoreSubdir avant l'appel`,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && name !== SANCTIONED_WRITER && index.has(name)) {
        const line0 = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        for (const slot of index.get(name)!) {
          if (slot.kind === 'param') {
            const arg = node.arguments[slot.index];
            if (argIsStoreDerived(arg, line0, lines, sf)) {
              flag(node, name, `arg#${slot.index}`);
              break;
            }
          } else {
            const owner = node.arguments[slot.ownerIndex];
            if (owner && ts.isObjectLiteralExpression(owner)) {
              let hit = false;
              for (const prop of owner.properties) {
                if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === slot.propName) {
                  hit = argIsStoreDerived(prop.initializer, line0, lines, sf);
                } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === slot.propName) {
                  hit = argIsStoreDerived(prop.name, line0, lines, sf);
                }
                if (hit) break;
              }
              if (hit) {
                flag(node, name, `${slot.propName}`);
                break;
              }
            }
          }
        }
      }
    }
    node.forEachChild(visit);
  }
  sf.forEachChild(visit);
  return out;
}

/** Voie 1 : dérivation directe dans la fenêtre de 4 lignes du mkdir. */
function scanDirectDerivations(rel: string, lines: string[]): Violation[] {
  const out: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
    if (!MKDIR_RE.test(line)) continue;
    const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    if (SHARED_TOKEN_RE.test(window)) {
      out.push({ file: rel, line: i + 1, text: line.trim(), reason: 'direct-derivation' });
    }
  }
  return out;
}

/** Scan complet (voie 1 + voie 2) d'un ensemble de sources — réelles ou synthétiques. */
export function scanSources(files: SourceSlice[]): Violation[] {
  const parsed: { rel: string; content: string; sf: ts.SourceFile }[] = [];
  for (const { rel, content } of files) {
    if (EXCLUDED.has(rel)) continue;
    parsed.push({ rel, content, sf: ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) });
  }

  const violations: Violation[] = [];
  const recursiveMkdirFns = new Map<string, MkdirSlot[]>();
  for (const { rel, sf } of parsed) indexRecursiveMkdirFunctions(rel, sf, recursiveMkdirFns);
  for (const { rel, content, sf } of parsed) {
    violations.push(...scanDirectDerivations(rel, content.split('\n')));
    violations.push(...scanParamDerivationCalls(rel, content, sf, recursiveMkdirFns));
  }
  return violations;
}

// ─────────────────── test principal (src/ réelle) ───────────────────

describe('structural: no raw mkdir on a store-root-derived path outside ensureStoreSubdir (#3459 b)', () => {
  it('every mkdir taking a shared-store-derived path routes through the helper (direct or via parameter)', () => {
    const files: SourceSlice[] = listSourceFiles(SRC_ROOT).map(file => ({
      rel: relative(SRC_ROOT, file),
      content: readFileSync(file, 'utf8'),
    }));

    expect(
      scanSources(files),
      'mkdir primitif sur un chemin dérivé de la racine du store HORS ensureStoreSubdir ' +
      '(direct ou par paramètre — migrer vers ensureStoreSubdir(...) — cf. #3459 arbitrage b, ' +
      'utils/shared-state-path.ts)'
    ).toEqual([]);
  });
});

// ─────────────────── contrôles négatifs committés (review PR #1116 pt 3) ───────────────────

const STASH_RECURSIVE = `
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export function stashFiles(files: string[], dest: string): string {
  const stamped = join(dest, 'backup-2026');
  if (!existsSync(stamped)) {
    mkdirSync(stamped, { recursive: true });
  }
  return stamped;
}
`;

const STASH_NON_RECURSIVE = `
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export function stashFiles(files: string[], dest: string): string {
  const stamped = join(dest, 'backup-2026');
  if (!existsSync(stamped)) {
    mkdirSync(stamped);
  }
  return stamped;
}
`;

const CALLER_STORE = `
import { join } from 'path';
import { stashFiles } from './stash.js';

export function applyDecision(sharedPath: string): string {
  const backupDir = join(sharedPath, 'decisions', 'backups');
  return stashFiles(['a.json'], backupDir);
}
`;

const CALLER_LOCAL = `
import { join } from 'path';
import { stashFiles } from './stash.js';

export function cacheLocal(tmpRoot: string): string {
  const dir = join(tmpRoot, 'cache');
  return stashFiles(['b'], dir);
}
`;

const DIRECT_ROGUE = `
import { mkdirSync } from 'fs';
import { join } from 'path';

export function rogueDir(sharedPath: string): void {
  mkdirSync(join(sharedPath, 'rogue'), { recursive: true });
}
`;

describe('contrôles négatifs — le garde mord (mutations tenues au vert du repo, #1116 review pt 3)', () => {
  it('voie 1 : mord sur une dérivation directe dans la fenêtre du mkdir', () => {
    const v = scanSources([{ rel: 'synthetic/direct.ts', content: DIRECT_ROGUE }]);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].file).toBe('synthetic/direct.ts');
    expect(v[0].reason).toBe('direct-derivation');
  });

  it('voie 2 : mord sur la dérivation PAR PARAMÈTRE — la forme exacte qui a échappé (createBackup/decision.ts, #1116 review pt 1)', () => {
    const v = scanSources([
      { rel: 'synthetic/stash.ts', content: STASH_RECURSIVE },
      { rel: 'synthetic/caller.ts', content: CALLER_STORE },
    ]);
    // Chaque moitié est invisible seule : le mkdir de stash.ts n'a aucun jeton
    // dans sa fenêtre, et l'appel de caller.ts n'est pas un primitif mkdir.
    // Seule la corrélation (slot mkdir récursif + arg store au site d'appel) mord.
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].file).toBe('synthetic/caller.ts');
    expect(v[0].reason).toContain('param-derivation');
  });

  it('voie 2 : ne mord PAS sur un chemin non-store (discrimination)', () => {
    const v = scanSources([
      { rel: 'synthetic/stash.ts', content: STASH_RECURSIVE },
      { rel: 'synthetic/caller-local.ts', content: CALLER_LOCAL },
    ]);
    expect(v).toEqual([]);
  });

  it('voie 2 : ne mord PAS sur un mkdir param NON récursif — incapable de recréer la racine (ENOENT fail-closed)', () => {
    const v = scanSources([
      { rel: 'synthetic/stash-nr.ts', content: STASH_NON_RECURSIVE },
      { rel: 'synthetic/caller.ts', content: CALLER_STORE },
    ]);
    expect(v).toEqual([]);
  });
});
