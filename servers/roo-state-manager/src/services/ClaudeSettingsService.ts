/**
 * ClaudeSettingsService — lecture/classification/projection/apply de ~/.claude/settings.json
 * Issue #3545 — couverture du picker Claude Code dans collect/publish/apply/compare
 *               + primitive campagne d'harmonisation.
 *
 * Principes de sécurité (non négociables) :
 *  - Un snapshot de comparaison N'EST PAS un payload d'apply. Seul un canon
 *    explicite (clés allow-listées, valeurs validées) peut être appliqué.
 *  - Jamais de credentials publiés : les clés sensibles sont masquées par
 *    digest, les autres clés top-level ne sont publiées que par leur NOM.
 *  - Apply : clés explicitement sélectionnées uniquement, mode ensure-present
 *    par défaut (les choix existants de la machine sont préservés), enforce-value
 *    sur demande explicite. permissions/hooks/apiKeyHelper ne sont jamais touchés.
 *  - Fail closed : fichier illisible/invalide => aucun write. Race d'écriture
 *    détectée => abort. Dry-run => zéro write, zéro backup.
 */

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { readFileWithoutBOM } from '../utils/encoding-helpers.js';
import { createLogger, Logger } from '../utils/logger.js';

const logger: Logger = createLogger('ClaudeSettingsService');

// ---------------------------------------------------------------------------
// État d'un fichier settings (discrimination missing / empty / invalid / ok)
// ---------------------------------------------------------------------------

export type ClaudeSettingsFileState = 'ok' | 'missing' | 'empty' | 'invalid';

export interface ClaudeSettingsReadResult {
  state: ClaudeSettingsFileState;
  /** Objet parsé ({} si missing/invalid). Jamais null. */
  settings: Record<string, unknown>;
  /** Message d'erreur quand state === 'invalid'. */
  error?: string;
  /** Contenu brut hashé (détection de concurrent edit). */
  contentHash?: string;
  mtimeMs?: number;
}

// ---------------------------------------------------------------------------
// Allow-list des chemins harmonisables (notation point, triée)
// ---------------------------------------------------------------------------

/**
 * Chemins (notation point) autorisés pour l'harmonisation ET pour le canon.
 * Tout chemin absent de cette liste est hors périmètre : jamais appliqué,
 * jamais compté dans un diff canon, jamais publié en clair.
 *
 * Le picker Claude Code (#3545) : ANTHROPIC_BASE_URL, ANTHROPIC_DEFAULT_*_MODEL
 * (suffixes [1m] inclus dans les valeurs), fenêtre/pourcentage de compaction.
 * `model` est l'ID de modèle top-level du settings.
 */
export const ALLOWED_KEY_PATHS: readonly string[] = Object.freeze([
  'env.API_TIMEOUT_MS',
  'env.ANTHROPIC_BASE_URL',
  'env.ANTHROPIC_CUSTOM_MODEL_OPTION',
  'env.ANTHROPIC_DEFAULT_FABLE_MODEL',
  'env.ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'env.ANTHROPIC_DEFAULT_OPUS_MODEL',
  'env.ANTHROPIC_DEFAULT_SONNET_MODEL',
  'env.ANTHROPIC_SMALL_FAST_MODEL',
  'env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'env.CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'env.MCP_TIMEOUT',
  'env.MCP_TOOL_TIMEOUT',
  'model',
  // #3545 — modelMap (la cartographie tier -> modèle). Forme défensive basée sur
  // le `modelMapping` des templates provider (opus/sonnet/haiku/fable -> string).
  // Chaque tier est un chemin point scalaire (comparable/applicable par tier),
  // jamais un objet opaque — la flotte exprime cette cartographie via les
  // env.ANTHROPIC_DEFAULT_{TIER}_MODEL ci-dessus, mais un settings avec un objet
  // modelMap reste couvert de façon bornée.
  'modelMap.fable',
  'modelMap.haiku',
  'modelMap.opus',
  'modelMap.sonnet',
]);

const ALLOWED_KEY_PATH_SET: Set<string> = new Set(ALLOWED_KEY_PATHS);

export function isAllowedKeyPath(path: string): boolean {
  return ALLOWED_KEY_PATH_SET.has(path);
}

/** Sévérité par défaut d'un écart sur un chemin harmonisable (compare #3545). */
export const KEY_PATH_SEVERITY: Record<string, string> = {
  'env.ANTHROPIC_BASE_URL': 'CRITICAL',
  'env.ANTHROPIC_CUSTOM_MODEL_OPTION': 'CRITICAL',
  'env.ANTHROPIC_DEFAULT_FABLE_MODEL': 'CRITICAL',
  'env.ANTHROPIC_DEFAULT_HAIKU_MODEL': 'CRITICAL',
  'env.ANTHROPIC_DEFAULT_OPUS_MODEL': 'CRITICAL',
  'env.ANTHROPIC_DEFAULT_SONNET_MODEL': 'CRITICAL',
  'env.ANTHROPIC_SMALL_FAST_MODEL': 'CRITICAL',
  'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW': 'IMPORTANT',
  'env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE': 'IMPORTANT',
  'env.CLAUDE_CODE_MAX_CONTEXT_TOKENS': 'IMPORTANT',
  'env.API_TIMEOUT_MS': 'WARNING',
  'env.MCP_TIMEOUT': 'WARNING',
  'env.MCP_TOOL_TIMEOUT': 'WARNING',
  'model': 'CRITICAL',
  'modelMap.fable': 'CRITICAL',
  'modelMap.haiku': 'CRITICAL',
  'modelMap.opus': 'CRITICAL',
  'modelMap.sonnet': 'CRITICAL',
};

// ---------------------------------------------------------------------------
// Détection de secrets — patterns clés + patterns valeurs
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /API_KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSPHRASE/i,
  /CREDENTIAL/i,
  /PRIVATE_KEY/i,
  /BEARER/i,
  /AUTH/i,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some(p => p.test(key));
}

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^(sk|rk|ghp|gho|ghu|ghs|github_pat|xox[bposa]|AKIA|AIza)[-_][A-Za-z0-9._-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^[a-f0-9]{40,64}$/i,
  /Bearer\s+[A-Za-z0-9._-]+/i,
  /(api[_-]?key|secret|token|password|passwd|credential)\s*[:=]/i,
];

export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some(p => p.test(value));
}

/**
 * Noms de paramètres de query sensibles — matching PAR MOT ENTIER (défaut
 * review #3 + réserve passe 3 : fin de la sur-redaction par sous-chaîne).
 * `auth`, `sig`, `api_key`, `x-api-key`, `access_token`, `secretKey`,
 * `myAuthToken`… sont couverts ; `design`, `signal`, `author` (qui ne
 * contiennent `sig`/`auth` que comme sous-chaîne) restent lisibles. Découpage :
 * séparateurs non alphanumériques + frontière camelCase + transitions
 * lettre↔chiffre (`token2`, `key2`, `apikey2`, `sig2`, `auth0` — revue passe
 * 4), mot comparé (en minuscules) à un ensemble fermé. Une valeur courte
 * qu'aucune heuristique de CONTENU ne détecte (ex. `?auth=3f9b2c`) reste
 * couverte par le NOM.
 */
const SENSITIVE_QUERY_WORDS = new Set([
  'key', 'keys', 'token', 'tokens', 'secret', 'secrets', 'signature', 'signatures',
  'password', 'passwd', 'passphrase', 'credential', 'credentials',
  'auth', 'authorization', 'authentication', 'sig',
  'apikey', 'session', 'sessionid', 'nonce', 'bearer',
  'accesskey', 'accesstoken', 'privatekey', 'authkey',
]);

function isSensitiveQueryParamName(key: string): boolean {
  if (!key) return false;
  // Frontières : camelCase ('secretKey' → 'secret Key'), séparateurs non
  // alphanumériques ('x-api-key' → ['x','api','key']) ET transitions
  // lettre↔chiffre ('token2'/'auth0' → ['token','2']/['auth','0'] — régression
  // revue passe 4 : le suffixe numérique d'un mot sensible reste couvert,
  // sans que 'design2'/'signal1' ne deviennent sensibles pour autant).
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some(w => SENSITIVE_QUERY_WORDS.has(w));
}

/**
 * Validation d'une valeur de canon. Retourne [] si sûre, sinon la liste des
 * motifs de rejet. Les URLs doivent être http(s), sans credentials inline,
 * sans query portant des paramètres secret-like.
 */
export function validateCanonValue(path: string, value: unknown): string[] {
  const problems: string[] = [];
  if (value === null || value === undefined) {
    problems.push('valeur null/undefined interdite dans un canon');
    return problems;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) problems.push('nombre non fini');
    return problems;
  }
  if (typeof value === 'boolean') return problems;
  if (typeof value !== 'string') {
    problems.push('type non supporté (scalaires uniquement : string | number | boolean)');
    return problems;
  }
  if (value.length === 0) {
    problems.push('chaîne vide interdite (présence sans valeur = non applicable)');
    return problems;
  }
  // Les chemins *_BASE_URL sont des URLs : validation dédiée d'abord (elle
  // nomme le paramètre fautif), pattern secret en second rideau — une URL
  // propre ne matche pas, une URL embeddant sk-… reste rejetée.
  if (/BASE_URL$/i.test(path)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      problems.push('BASE_URL invalide (non parsable)');
      return problems;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`protocole non autorisé: ${url.protocol}`);
    }
    if (url.username || url.password) {
      problems.push('credentials inline dans l’URL (user:pass@)');
    }
    for (const [k] of url.searchParams) {
      if (isSensitiveQueryParamName(k)) {
        problems.push(`paramètre de query interdit: ${k}`);
      }
    }
    if (problems.length > 0) return problems;
    if (looksLikeSecretValue(value)) {
      problems.push('valeur au pattern secret (jamais publiée/appliquée)');
    }
    return problems;
  }
  if (looksLikeSecretValue(value)) {
    problems.push('valeur au pattern secret (jamais publiée/appliquée)');
    return problems;
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Projection canonique + hash
// ---------------------------------------------------------------------------

/** Lit une valeur à un chemin point ("env.KEY" | "model"). */
export function getPath(settings: Record<string, unknown>, path: string): unknown {
  const segs = path.split('.');
  let cur: unknown = settings;
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/** Écrit une valeur à un chemin point (crée les objets intermédiaires). Mutate. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur[s] === null || typeof cur[s] !== 'object' || Array.isArray(cur[s])) {
      cur[s] = {};
    }
    cur = cur[s] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

/**
 * Projection harmonisation d'un settings : les chemins allow-listés présents,
 * hors exemptés, ordre de clés déterministe. Base de tout hash canon/observé.
 */
export function projectSettings(
  settings: Record<string, unknown>,
  exemptedPaths: string[] = []
): Record<string, unknown> {
  const exempt = new Set(exemptedPaths);
  const out: Record<string, unknown> = {};
  for (const path of ALLOWED_KEY_PATHS) {
    if (exempt.has(path)) continue;
    const v = getPath(settings, path);
    if (v !== undefined) out[path] = v;
  }
  return out;
}

/**
 * Projection REDACTÉE — pour publication de snapshot et comparaison affichée.
 * Même périmètre que `projectSettings` mais chaque valeur passe par `redactValue` :
 * jamais de credential/URL sensible brut dans un snapshot ou une sortie de compare.
 * À NE PAS utiliser pour l'alignement canon (qui travaille sur mesures réelles).
 */
export function projectSettingsSafe(
  settings: Record<string, unknown>,
  exemptedPaths: string[] = []
): Record<string, unknown> {
  const exempt = new Set(exemptedPaths);
  const out: Record<string, unknown> = {};
  for (const path of ALLOWED_KEY_PATHS) {
    if (exempt.has(path)) continue;
    const v = getPath(settings, path);
    if (v !== undefined) out[path] = redactValue(path, v);
  }
  return out;
}

/** Hash canonique d'une projection (clés triées, JSON stable). */
export function hashProjection(projection: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(projection).sort()) sorted[k] = projection[k];
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** Hash du contenu brut d'un fichier (détection concurrent edit). */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Digest masqué d'une valeur sensible (modèle #3044). */
export function maskSecretValue(value: unknown): string {
  if (value === null || value === undefined) return '<unset>';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str === undefined) return '<unset>';
  if (str.length === 0) return '<empty>';
  const hash = createHash('sha256').update(str).digest('hex').substring(0, 8);
  return `<set:len=${str.length}:sha256=${hash}>`;
}

/**
 * Empreinte NON RÉVERSIBLE d'un composant secret (sha256, préfixe 16 hex —
 * défaut review #1) : discrimine deux secrets DISTINCTS dans la représentation
 * de comparaison sans les exposer. Deux userinfo (ou deux valeurs de query
 * sensibles) différents produisent deux marqueurs différents => compare_config
 * voit la divergence (pas de conformité fabriquée) ; le secret lui-même ne
 * quitte jamais la machine (sens unique). Déterministe : le même secret
 * produit toujours la même empreinte, sur les deux côtés d'une comparaison.
 */
function secretDigest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').substring(0, 16);
}

/**
 * Redaction d'une valeur pour publication/comparaison — jamais de credential raw.
 *
 * #3545 défaut (review) #1 — `projectSettings` recopiait les valeurs allow-listées
 * telles quelles dans le snapshot publié, y compris ANTHROPIC_BASE_URL : des
 * credentials embarqués (userinfo ou query) pouvaient atteindre les snapshots
 * partagés et la sortie de compare. Cette fonction protège TOUS les chemins de
 * publication/affichage, y compris les valeurs malformées/inattendues.
 *
 * IMPORTANT — sémantique d'alignement séparée de la redaction, et DISCRIMINATION
 * non réversible (défaut review #1, passe 2) : un userinfo est remplacé par
 * `<credentials:sha256=…>` et une valeur de query sensible par
 * `<redacted:sha256=…>`, où `…` est l'empreinte sha256 (sens unique) du composant
 * secret. Deux URLs identiques restent identiques ; deux secrets DIFFÉRENTS sur
 * le même host/path produisent deux marqueurs DIFFÉRENTS — compare_config voit
 * la divergence (cohérent avec confirm(), qui travaille sur mesures réelles) et
 * la redaction ne peut fabriquer NI une conformité NI un alignement. Le secret
 * lui-même n'est jamais exposé. Une URL malformée est entièrement masquée
 * (digest) — jamais publiée brute.
 */
export function redactValue(path: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  // Idempotence : une valeur déjà redactée doit retourner telle quelle — sinon
  // projectSettingsSafe puis formatValue (même chemin) re-redacteraient et
  // 'https://<credentials:sha256=…>@…' serait dégradé en digest (défaut review #1).
  if (
    value.includes('<credentials@>') || // marqueurs hérités (anciens snapshots)
    value.includes('<redacted>') ||
    value.includes('<credentials:sha256=') || // marqueurs courants (empreinte)
    value.includes('<redacted:sha256=') ||
    /^<set:len=\d+:sha256=[0-9a-f]{8}>$/.test(value)
  ) {
    return value;
  }
  if (/BASE_URL$/i.test(path)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      // URL non parsable : on ne publie jamais le raw — digest seul.
      return maskSecretValue(value);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      // Protocole non attendu (file:, etc.) — digest, jamais broadcast brut.
      return maskSecretValue(value);
    }
    // Reconstruit À PARTIR de la chaîne d'origine pour préserver le path exact
    // (slash final inclus) — ne normalise pas 'https://h' en 'https://h/' qui
    // fabriquerait une conformité entre des URL distinctes.
    let out = value;
    if (url.username || url.password) {
      // le userinfo est le premier '//x@' — sûr car url.username/password le
      // confirment. L'empreinte (non réversible) du userinfo garde la
      // discrimination : deux credentials différents => deux marqueurs
      // différents (défaut review #1), sans jamais exposer le raw.
      const m = /\/\/([^@/]+)@/.exec(out);
      const userinfoSecret = m ? m[1] : `${url.username}:${url.password}`;
      out = out.replace(/\/\/[^@/]+@/, `//<credentials:sha256=${secretDigest(userinfoSecret)}>@`);
    }
    const sensitiveParams = [...url.searchParams.keys()].filter(
      k => isSensitiveQueryParamName(k) || looksLikeSecretValue(url.searchParams.get(k) || '')
    );
    if (sensitiveParams.length > 0) {
      // Reconstruit la query en préservant l'ordre et les valeurs non sensibles,
      // en remplaçant la VALEUR des paramètres sensibles par un marqueur
      // EMPREINTE (non réversible : deux valeurs différentes => deux marqueurs
      // différents) — pas d'encodage URL qui transformerait le marqueur en
      // '%3C…%3E'.
      const sensitive = new Set(sensitiveParams);
      const parts = url.search.slice(1).split('&').map(pair => {
        const eq = pair.indexOf('=');
        const k = eq >= 0 ? pair.slice(0, eq) : pair;
        if (sensitive.has(k)) {
          const decoded = url.searchParams.get(k) ?? (eq >= 0 ? pair.slice(eq + 1) : '');
          return `${k}=<redacted:sha256=${secretDigest(decoded)}>`;
        }
        return pair;
      });
      out = out.replace(/\?[^#]*/, `?${parts.join('&')}`);
    }
    return out;
  }
  if (looksLikeSecretValue(value)) return maskSecretValue(value);
  return value;
}

// ---------------------------------------------------------------------------
// Snapshot de comparaison (collect/publish) — secrets masqués, jamais raw
// ---------------------------------------------------------------------------

export interface ClaudeSettingsSnapshot {
  /** Version du format snapshot. */
  format: 1;
  /** État du fichier au moment de la collecte. */
  state: ClaudeSettingsFileState;
  collectedAt: string;
  machineId: string;
  /** Chemins harmonisables présents (allow-list uniquement, valeurs claires — non sensibles par définition). */
  harmonization: Record<string, unknown>;
  /** Digest de présence des clés env sensibles (jamais la valeur). */
  maskedEnvKeys: Record<string, string>;
  /** NOMS des autres clés top-level (permissions, hooks, etc.) — présence seulement, aucun contenu. */
  otherTopLevelKeys: string[];
  /** Hash de la projection harmonisation (comparaison rapide sans exposer les valeurs). */
  projectionHash: string;
  error?: string;
}

export function buildSnapshot(
  read: ClaudeSettingsReadResult,
  machineId: string,
  nowIso: string
): ClaudeSettingsSnapshot {
  const env = (read.settings.env && typeof read.settings.env === 'object' && !Array.isArray(read.settings.env))
    ? read.settings.env as Record<string, unknown>
    : {};
  const maskedEnvKeys: Record<string, string> = {};
  for (const k of Object.keys(env).sort()) {
    if (isSensitiveKey(k)) maskedEnvKeys[k] = maskSecretValue(env[k]);
  }
  const covered = new Set(['env', ...ALLOWED_KEY_PATHS.map(p => p.split('.')[0])]);
  const otherTopLevelKeys = Object.keys(read.settings)
    .filter(k => !covered.has(k))
    .sort();

  return {
    format: 1,
    state: read.state,
    collectedAt: nowIso,
    machineId,
    // Redaction #3545 : harmonization = projection REDACTÉE (jamais de valeur
    // sensible/credential brute). Le projectionHash est celui de cette même
    // projection redactée — cohérent avec la comparaison côté compare.
    harmonization: projectSettingsSafe(read.settings),
    maskedEnvKeys,
    otherTopLevelKeys,
    projectionHash: hashProjection(projectSettingsSafe(read.settings)),
    error: read.error,
  };
}

// ---------------------------------------------------------------------------
// Canon — payload d'apply explicite, versionné, validé
// ---------------------------------------------------------------------------

export type CanonMode = 'ensure-present' | 'enforce-value';

export interface CanonPayload {
  version: string;
  mode: CanonMode;
  /** Chemins allow-listés explicites => valeurs. Rien d'implicite. */
  keys: Record<string, unknown>;
  description?: string;
}

export interface CanonValidationResult {
  valid: boolean;
  problems: string[];
  canonHash?: string;
}

/**
 * Valide un canon : chemins allow-listés uniquement, valeurs scalaires sûres,
 * version non vide, mode connu. Calcule le hash canon (lié aux confirmations).
 */
export function validateCanon(canon: CanonPayload): CanonValidationResult {
  const problems: string[] = [];
  if (!canon || typeof canon !== 'object') {
    return { valid: false, problems: ['canon absent ou non objet'] };
  }
  if (!canon.version || typeof canon.version !== 'string' || canon.version.trim() === '') {
    problems.push('version requise (canon immuable : bump de version pour changer)');
  }
  if (canon.mode !== 'ensure-present' && canon.mode !== 'enforce-value') {
    problems.push(`mode invalide: ${String(canon.mode)} (ensure-present | enforce-value)`);
  }
  if (!canon.keys || typeof canon.keys !== 'object' || Array.isArray(canon.keys)) {
    problems.push('keys requis (objet chemin => valeur)');
    return { valid: false, problems };
  }
  for (const [path, value] of Object.entries(canon.keys)) {
    if (!isAllowedKeyPath(path)) {
      problems.push(`chemin non allow-listé: ${path}`);
      continue;
    }
    if (isSensitiveKey(path)) {
      problems.push(`chemin sensible interdit dans un canon: ${path}`);
      continue;
    }
    problems.push(...validateCanonValue(path, value).map(p => `${path}: ${p}`));
  }
  if (problems.length > 0) return { valid: false, problems };
  const projection: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(canon.keys)) projection[path] = value;
  return { valid: true, problems: [], canonHash: hashProjection(projection) };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyCanonChange {
  path: string;
  before?: unknown;
  after: unknown;
  action: 'set' | 'preserved';
}

export interface ApplyCanonResult {
  applied: boolean;
  changes: ApplyCanonChange[];
  skipped: Array<{ path: string; reason: string }>;
  backupPath?: string;
  /** Relecture post-write : projection attendue vs observée. */
  verification?: { performed: boolean; success: boolean; observedHash: string; expectedHash: string };
}

export interface ApplyCanonOptions {
  dryRun?: boolean;
  backup?: boolean;
  /** Chemins exemptés POUR CETTE MACHINE (skip apply + hash). */
  exemptedPaths?: string[];
  /** Horloge injectable (tests). */
  now?: () => string;
}

/**
 * Applique un canon VALIDÉ au fichier settings local.
 *
 * - ensure-present : pose les clés absentes, préserve les existantes (choix machine).
 * - enforce-value   : écrase les clés listées.
 * - Jamais de clé hors allow-list ; jamais permissions/hooks/apiKeyHelper touchés
 *   (ils ne sont jamais dans canon.keys, validé en amont).
 * - Concurrent edit : le fichier est relu AVANT le write ; si le hash a changé
 *   depuis la lecture initiale => conflit, abort (fail closed).
 * - Backup puis re-read validation après write (restauration si échec).
 */
export async function applyCanonToFile(
  settingsPath: string,
  canon: CanonPayload,
  options: ApplyCanonOptions = {}
): Promise<ApplyCanonResult> {
  const dryRun = options.dryRun === true;
  const backup = options.backup !== false;
  const exempt = new Set(options.exemptedPaths || []);
  const nowIso = (options.now || (() => new Date().toISOString()))();

  // 1. Lecture + classification — fail closed si invalide
  const read = await readClaudeSettingsFile(settingsPath);
  if (read.state === 'invalid') {
    throw new Error(
      `settings.json illisible/invalide (${settingsPath}) — apply refusé (fail closed): ${read.error}`
    );
  }

  const working: Record<string, unknown> = JSON.parse(JSON.stringify(read.settings));
  const changes: ApplyCanonChange[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let wouldWrite = false;

  for (const [path, value] of Object.entries(canon.keys)) {
    if (exempt.has(path)) {
      skipped.push({ path, reason: 'exempté pour cette machine' });
      continue;
    }
    const current = getPath(working, path);
    if (current === undefined) {
      setPath(working, path, value);
      changes.push({ path, after: value, action: 'set' });
      wouldWrite = true;
    } else if (JSON.stringify(current) === JSON.stringify(value)) {
      skipped.push({ path, reason: 'déjà conforme' });
    } else if (canon.mode === 'ensure-present') {
      skipped.push({ path, reason: 'présent localement — préservé (ensure-present)' });
      changes.push({ path, before: current, after: current, action: 'preserved' });
    } else {
      setPath(working, path, value);
      changes.push({ path, before: current, after: value, action: 'set' });
      wouldWrite = true;
    }
  }

  const expectedProjection = projectSettings(working, options.exemptedPaths || []);
  const expectedHash = hashProjection(expectedProjection);

  if (dryRun) {
    return {
      applied: false,
      changes,
      skipped,
      verification: { performed: false, success: true, observedHash: '', expectedHash },
    };
  }

  if (!wouldWrite) {
    // Rien à écrire — idempotent
    return {
      applied: true,
      changes,
      skipped,
      verification: { performed: true, success: true, observedHash: expectedHash, expectedHash },
    };
  }

  // 2. Backup (avant tout write)
  let backupPath: string | undefined;
  if (backup && existsSync(settingsPath)) {
    backupPath = `${settingsPath}.backup-${nowIso.replace(/[:.]/g, '-')}`;
    await fs.copyFile(settingsPath, backupPath);
    logger.info(`Backup settings.json: ${backupPath}`);
  }

  // 3. Détection concurrent edit : relecture immédiate pré-write
  const preWrite = await readClaudeSettingsFile(settingsPath);
  if (preWrite.contentHash !== read.contentHash) {
    throw new Error(
      'settings.json a changé pendant la préparation de l’apply (concurrent edit) — abort. Rejouer l’apply.'
    );
  }

  // 4. Write atomique (tmp + rename), UTF-8 sans BOM
  await fs.mkdir(dirname(settingsPath), { recursive: true });
  const content = JSON.stringify(working, null, 2) + '\n';
  const tmpPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, settingsPath);

  // 5. Re-read validation
  const post = await readClaudeSettingsFile(settingsPath);
  const observedHash = hashProjection(projectSettings(post.settings, options.exemptedPaths || []));
  const verification = {
    performed: true,
    success: observedHash === expectedHash,
    observedHash,
    expectedHash,
  };
  if (!verification.success) {
    // Restaure le backup si disponible — ne laisse pas un état non vérifié.
    if (backupPath && existsSync(backupPath)) {
      await fs.copyFile(backupPath, settingsPath);
      logger.warn(`Vérification post-apply échouée — backup restauré: ${backupPath}`);
    }
    throw new Error(
      `Vérification post-apply échouée (attendu ${expectedHash}, observé ${observedHash}) — backup restauré si disponible`
    );
  }

  return { applied: true, changes, skipped, backupPath, verification };
}

// ---------------------------------------------------------------------------
// Service — résolution du chemin + lecture classifiée
// ---------------------------------------------------------------------------

export class ClaudeSettingsService {
  private readonly settingsPath: string;

  constructor(settingsPath?: string) {
    this.settingsPath = settingsPath
      || process.env.CLAUDE_SETTINGS_PATH
      || join(homedir(), '.claude', 'settings.json');
  }

  getPath(): string {
    return this.settingsPath;
  }

  async read(): Promise<ClaudeSettingsReadResult> {
    return readClaudeSettingsFile(this.settingsPath);
  }

  /** Projection + hash live de la machine locale (confirmations, drift). */
  async readProjection(exemptedPaths: string[] = []): Promise<{ projection: Record<string, unknown>; hash: string; state: ClaudeSettingsFileState }> {
    const read = await readClaudeSettingsFile(this.settingsPath);
    const projection = projectSettings(read.settings, exemptedPaths);
    return { projection, hash: hashProjection(projection), state: read.state };
  }
}

// ---------------------------------------------------------------------------
// Localisation du snapshot publié d'une machine (store partagé RooSync)
// ---------------------------------------------------------------------------

export interface PublishedSnapshotLookup {
  found: boolean;
  snapshot?: ClaudeSettingsSnapshot;
  path?: string;
  /** Horodatage de collecte du snapshot trouvé (ISO). */
  collectedAt?: string;
  error?: string;
}

/**
 * Trouve le snapshot claude-settings le plus récent publié par une machine,
 * dans {shared}/configs/{machineId}/ :
 *   1. claude-settings/claude-settings.json (standalone)
 *   2. paquets versionnés — vXYZ/claude-settings/claude-settings.json (tri lexical décroissant)
 *
 * Retourne found:false (pas d'exception) si rien — l'appelant décide si
 * « pas de snapshot » = non couvert (compare) ou inconnu (drift distant).
 */
export async function findLatestClaudeSettingsSnapshot(
  sharedStatePath: string,
  machineId: string
): Promise<PublishedSnapshotLookup> {
  const configsDir = join(sharedStatePath, 'configs', machineId);
  if (!existsSync(configsDir)) return { found: false };

  const tryRead = async (p: string): Promise<ClaudeSettingsSnapshot | undefined> => {
    try {
      const raw = await readFileWithoutBOM(p);
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.format === 1 && 'harmonization' in parsed) {
        return parsed as ClaudeSettingsSnapshot;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  // 1. Standalone
  const standalone = join(configsDir, 'claude-settings', 'claude-settings.json');
  if (existsSync(standalone)) {
    const snap = await tryRead(standalone);
    if (snap) return { found: true, snapshot: snap, path: standalone, collectedAt: snap.collectedAt };
  }

  // 2. Paquets versionnés (v{version}-{timestamp}, tri lexical ≈ chronologique)
  try {
    const entries = await fs.readdir(configsDir, { withFileTypes: true });
    const versionDirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith('v'))
      .map(e => e.name)
      .sort()
      .reverse();
    for (const dir of versionDirs) {
      const p = join(configsDir, dir, 'claude-settings', 'claude-settings.json');
      if (existsSync(p)) {
        const snap = await tryRead(p);
        if (snap) return { found: true, snapshot: snap, path: p, collectedAt: snap.collectedAt };
      }
    }
  } catch { /* répertoire illisible => pas de snapshot */ }

  return { found: false };
}

/**
 * Lecture classifiée d'un fichier settings.json.
 * Discrimine missing (ENOENT) / empty (objet JSON à 0 clés) / invalid
 * (illisible ou non-objet JSON) / ok.
 */
export async function readClaudeSettingsFile(settingsPath: string): Promise<ClaudeSettingsReadResult> {
  if (!existsSync(settingsPath)) {
    return { state: 'missing', settings: {} };
  }
  let raw: string;
  try {
    raw = await readFileWithoutBOM(settingsPath);
  } catch (err) {
    return {
      state: 'invalid',
      settings: {},
      error: `illisible: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const contentHash = hashContent(raw);
  let mtimeMs: number | undefined;
  try {
    mtimeMs = (await fs.stat(settingsPath)).mtimeMs;
  } catch { /* non bloquant */ }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      state: 'invalid',
      settings: {},
      error: `JSON invalide: ${err instanceof Error ? err.message : String(err)}`,
      contentHash,
      mtimeMs,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      state: 'invalid',
      settings: {},
      error: 'racine non objet (null/array)',
      contentHash,
      mtimeMs,
    };
  }
  const settings = parsed as Record<string, unknown>;
  const state: ClaudeSettingsFileState = Object.keys(settings).length === 0 ? 'empty' : 'ok';
  return { state, settings, contentHash, mtimeMs };
}