/**
 * Tests ClaudeSettingsService — #3545
 *
 * Couverture exigée par l'issue :
 *  - discrimination missing / valid-empty / invalid / ok
 *  - projection + hash canoniques (déterministes, exemptés exclus)
 *  - snapshot de comparaison : secrets JAMAIS publiés (digests), autres clés
 *    top-level par NOM seulement
 *  - canon : allow-list, valeurs secrètes/URLs suspectes rejetées
 *  - apply : préservation (ensure-present), enforce-value explicite, dry-run
 *    sans write, idempotence, fail-closed sur fichier invalide, détection
 *    concurrent-edit, backup + re-read validation, contrôle positif canon
 *
 * Tout se joue sur des répertoires FAKE (tmpdir) — jamais le settings réel.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readClaudeSettingsFile,
  projectSettings,
  projectSettingsSafe,
  redactValue,
  hashProjection,
  buildSnapshot,
  validateCanon,
  applyCanonToFile,
  findLatestClaudeSettingsSnapshot,
  isAllowedKeyPath,
  maskSecretValue,
  ALLOWED_KEY_PATHS,
  CanonPayload,
} from '../ClaudeSettingsService.js';

let fakeDir: string;
let settingsPath: string;

beforeEach(() => {
  fakeDir = mkdtempSync(join(tmpdir(), 'claude-settings-test-'));
  settingsPath = join(fakeDir, 'settings.json');
});

afterEach(() => {
  rmSync(fakeDir, { recursive: true, force: true });
});

function writeSettings(obj: unknown): void {
  mkdirSync(join(settingsPath, '..'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(obj, null, 2), 'utf-8');
}

describe('readClaudeSettingsFile — discrimination des états', () => {
  test('missing : fichier absent', async () => {
    const r = await readClaudeSettingsFile(settingsPath);
    expect(r.state).toBe('missing');
    expect(r.settings).toEqual({});
  });

  test('empty : fichier valide à 0 clés (≠ missing)', async () => {
    writeSettings({});
    const r = await readClaudeSettingsFile(settingsPath);
    expect(r.state).toBe('empty');
    expect(r.settings).toEqual({});
  });

  test('invalid : JSON cassé', async () => {
    writeFileSync(settingsPath, '{not json', 'utf-8');
    const r = await readClaudeSettingsFile(settingsPath);
    expect(r.state).toBe('invalid');
    expect(r.error).toMatch(/JSON invalide/);
  });

  test('invalid : racine non objet (array)', async () => {
    writeSettings([1, 2, 3]);
    const r = await readClaudeSettingsFile(settingsPath);
    expect(r.state).toBe('invalid');
    expect(r.error).toMatch(/racine non objet/);
  });

  test('ok : fichier valide avec clés + contentHash stable', async () => {
    writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://relay.example' } });
    const r1 = await readClaudeSettingsFile(settingsPath);
    const r2 = await readClaudeSettingsFile(settingsPath);
    expect(r1.state).toBe('ok');
    expect(r1.contentHash).toBeDefined();
    expect(r1.contentHash).toBe(r2.contentHash);
  });

  test('tolère un BOM UTF-8 (#664)', async () => {
    writeFileSync(settingsPath, '﻿{"model": "sonnet"}', 'utf-8');
    const r = await readClaudeSettingsFile(settingsPath);
    expect(r.state).toBe('ok');
    expect(r.settings.model).toBe('sonnet');
  });
});

describe('projection + hash', () => {
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: 'https://a.example',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: 280000,
      ANTHROPIC_API_KEY: 'sk-secret-value',       // hors allow-list => jamais projeté
      SOMETHING_UNRELATED: 'x',
    },
    model: 'opus',
    permissions: { allow: ['Bash'] },               // hors allow-list
  };

  test('projette uniquement les chemins allow-listés présents', () => {
    const p = projectSettings(settings);
    expect(p).toEqual({
      'env.ANTHROPIC_BASE_URL': 'https://a.example',
      'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW': 280000,
      'model': 'opus',
    });
  });

  test('les exemptés sont exclus (canon par machine)', () => {
    const p = projectSettings(settings, ['env.CLAUDE_CODE_AUTO_COMPACT_WINDOW']);
    expect(p).not.toHaveProperty('env.CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });

  test('hash déterministe : ordre des clés indifférent', () => {
    const a = { 'model': 'opus', 'env.ANTHROPIC_BASE_URL': 'https://a.example' };
    const b = { 'env.ANTHROPIC_BASE_URL': 'https://a.example', 'model': 'opus' };
    expect(hashProjection(a)).toBe(hashProjection(b));
  });

  test('isAllowedKeyPath : allow-list stricte', () => {
    expect(isAllowedKeyPath('env.ANTHROPIC_BASE_URL')).toBe(true);
    expect(isAllowedKeyPath('env.ANTHROPIC_API_KEY')).toBe(false);   // sensible + hors liste
    expect(isAllowedKeyPath('permissions.allow')).toBe(false);
    expect(isAllowedKeyPath('hooks')).toBe(false);
    expect(ALLOWED_KEY_PATHS).not.toContain('env.ANTHROPIC_API_KEY');
  });
});

describe('buildSnapshot — non-divulgation des secrets à la sérialisation', () => {
  test('clés env sensibles masquées en digest, jamais la valeur', async () => {
    const read = await readClaudeSettingsFileFrom(settingsPath, {
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-supersecret-value-123',
        ANTHROPIC_AUTH_TOKEN: 'tok_abc',
        ANTHROPIC_BASE_URL: 'https://relay.example',
      },
      permissions: { allow: ['Bash(ls*)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
      apiKeyHelper: '/usr/local/bin/helper.sh',
      model: 'sonnet',
    });
    const snap = buildSnapshot(read, 'machine-x', '2026-09-08T10:00:00Z');

    const serialized = JSON.stringify(snap);
    // Le secret ne doit JAMAIS apparaître dans la sérialisation
    expect(serialized).not.toContain('sk-ant-supersecret');
    expect(serialized).not.toContain('tok_abc');
    expect(serialized).not.toContain('helper.sh');
    expect(serialized).not.toContain('Bash(ls*)');

    // Présence attestée par digest
    expect(snap.maskedEnvKeys['ANTHROPIC_API_KEY']).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);
    expect(snap.maskedEnvKeys['ANTHROPIC_AUTH_TOKEN']).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);

    // Autres clés top-level : NOMS seulement
    expect(snap.otherTopLevelKeys).toContain('permissions');
    expect(snap.otherTopLevelKeys).toContain('hooks');
    expect(snap.otherTopLevelKeys).toContain('apiKeyHelper');

    // Harmonisation : allow-list uniquement, valeurs claires
    expect(snap.harmonization).toEqual({
      'env.ANTHROPIC_BASE_URL': 'https://relay.example',
      'model': 'sonnet',
    });
    expect(snap.state).toBe('ok');
    expect(snap.projectionHash).toBe(hashProjection(snap.harmonization));
  });

  test('état missing snapshoté tel quel (couverture détectable côté compare)', async () => {
    const read = await readClaudeSettingsFile(settingsPath); // absent
    const snap = buildSnapshot(read, 'machine-x', '2026-09-08T10:00:00Z');
    expect(snap.state).toBe('missing');
    expect(snap.harmonization).toEqual({});
  });
});

describe('validateCanon — allow-list + valeurs sûres', () => {
  const baseCanon: CanonPayload = {
    version: '2026.09.08-1',
    mode: 'ensure-present',
    keys: { 'env.ANTHROPIC_BASE_URL': 'https://relay.example' },
  };

  test('contrôle positif : canon valide produit un hash', () => {
    const v = validateCanon(baseCanon);
    expect(v.valid).toBe(true);
    expect(v.canonHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('chemin hors allow-list rejeté', () => {
    const v = validateCanon({ ...baseCanon, keys: { 'permissions.allow': ['x'] } });
    expect(v.valid).toBe(false);
    expect(v.problems.join()).toMatch(/non allow-listé/);
  });

  test('chemin sensible rejeté même s il était allow-listé', () => {
    const v = validateCanon({ ...baseCanon, keys: { 'env.ANTHROPIC_API_KEY': 'whatever' } });
    expect(v.valid).toBe(false);
  });

  test('valeur au pattern secret rejetée (sk-, ghp_, hex64, BEGIN KEY)', () => {
    for (const bad of ['sk-ant-123', 'ghp_abcdef', 'a'.repeat(64), '-----BEGIN PRIVATE KEY-----']) {
      const v = validateCanon({ ...baseCanon, keys: { 'model': bad } });
      expect(v.valid).toBe(false);
      expect(v.problems.join()).toMatch(/secret/);
    }
  });

  test('BASE_URL : credentials inline rejetés', () => {
    const v = validateCanon({ ...baseCanon, keys: { 'env.ANTHROPIC_BASE_URL': 'https://user:pass@relay.example' } });
    expect(v.valid).toBe(false);
    expect(v.problems.join()).toMatch(/credentials inline/);
  });

  test('BASE_URL : query avec paramètre token rejeté', () => {
    const v = validateCanon({ ...baseCanon, keys: { 'env.ANTHROPIC_BASE_URL': 'https://relay.example/?token=abc' } });
    expect(v.valid).toBe(false);
    expect(v.problems.join()).toMatch(/paramètre de query interdit/);
  });

  test('BASE_URL : protocole non http(s) rejeté', () => {
    const v = validateCanon({ ...baseCanon, keys: { 'env.ANTHROPIC_BASE_URL': 'file:///etc/passwd' } });
    expect(v.valid).toBe(false);
  });

  test('BASE_URL http(s) propre acceptée', () => {
    const v = validateCanon({ ...baseCanon, keys: { 'env.ANTHROPIC_BASE_URL': 'https://relay.example/v1' } });
    expect(v.valid).toBe(true);
  });

  test('objets/valeurs composites rejetés (scalaires uniquement)', () => {
    const v = validateCanon({ ...baseCanon, keys: { 'model': { nested: true } } });
    expect(v.valid).toBe(false);
    expect(v.problems.join()).toMatch(/type non supporté/);
  });

  test('version et mode requis', () => {
    expect(validateCanon({ ...baseCanon, version: '' }).valid).toBe(false);
    expect(validateCanon({ ...baseCanon, mode: 'overwrite-everything' as any }).valid).toBe(false);
  });
});

describe('applyCanonToFile', () => {
  const canon: CanonPayload = {
    version: '2026.09.08-1',
    mode: 'ensure-present',
    keys: {
      'env.ANTHROPIC_BASE_URL': 'https://relay.example',
      'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW': 280000,
    },
  };

  test('ensure-present : pose les absentes, PRÉSERVE les existantes (choix machine)', async () => {
    writeSettings({
      env: { ANTHROPIC_BASE_URL: 'https://local-choice.example', OTHER: 'keep' },
      permissions: { allow: ['Bash'] },
    });
    const res = await applyCanonToFile(settingsPath, canon, { now: () => '2026-09-08T10:00:00Z' });

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://local-choice.example');   // préservé
    expect(after.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(280000);              // posé
    expect(after.env.OTHER).toBe('keep');                                        // intact
    expect(after.permissions).toEqual({ allow: ['Bash'] });                      // jamais touché

    const preserved = res.changes.find(c => c.action === 'preserved');
    expect(preserved?.path).toBe('env.ANTHROPIC_BASE_URL');
    expect(preserved?.before).toBe('https://local-choice.example');
  });

  test('enforce-value : écrase explicitement', async () => {
    writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://old.example' } });
    await applyCanonToFile(settingsPath, { ...canon, mode: 'enforce-value' }, { now: () => '2026-09-08T10:00:00Z' });
    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://relay.example');
  });

  test('dry-run : AUCUN write, AUCUN backup', async () => {
    writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://old.example' } });
    const before = readFileSync(settingsPath, 'utf-8');
    const res = await applyCanonToFile(settingsPath, canon, { dryRun: true });
    expect(res.applied).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
    expect(existsSync(`${settingsPath}.backup-2026-09-08T10-00-00Z`)).toBe(false);
  });

  test('idempotent : second apply ne réécrit pas (déjà conforme)', async () => {
    writeSettings({});
    await applyCanonToFile(settingsPath, canon, { now: () => '2026-09-08T10:00:00Z', backup: false });
    const first = readFileSync(settingsPath, 'utf-8');
    const res2 = await applyCanonToFile(settingsPath, canon, { now: () => '2026-09-08T10:00:00Z', backup: false });
    expect(readFileSync(settingsPath, 'utf-8')).toBe(first);
    expect(res2.skipped.some(s => s.reason === 'déjà conforme')).toBe(true);
  });

  test('fail closed : fichier invalide => aucun write', async () => {
    writeFileSync(settingsPath, '{broken', 'utf-8');
    await expect(applyCanonToFile(settingsPath, canon)).rejects.toThrow(/fail closed/);
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{broken');
  });

  test('backup créé puis re-read validé (verification.success)', async () => {
    writeSettings({ env: {} });
    const res = await applyCanonToFile(settingsPath, canon, { now: () => '2026-09-08T10:00:00Z' });
    expect(res.backupPath).toMatch(/backup-2026-09-08T10-00-00Z/);
    expect(existsSync(res.backupPath!)).toBe(true);
    expect(res.verification?.performed).toBe(true);
    expect(res.verification?.success).toBe(true);
  });

  test('concurrent edit détecté : fichier modifié entre lecture et write => abort', async () => {
    writeSettings({ env: {} });
    // Course déterministe : le backup (copyFile) s'exécute ENTRE la lecture initiale
    // et la relecture pré-write de applyCanonToFile — on y injecte une mutation
    // externe du settings ; la garde pré-write doit voir un hash différent et avorter.
    const fsMod = await import('fs');
    const originalCopyFile = fsMod.promises.copyFile;
    let injected = false;
    (fsMod.promises as any).copyFile = async function patched(...args: any[]) {
      if (!injected) {
        injected = true;
        writeFileSync(settingsPath, JSON.stringify({ env: { INJECTED: true } }), 'utf-8');
      }
      return originalCopyFile.apply(fsMod.promises, args as any);
    };
    try {
      await expect(
        applyCanonToFile(settingsPath, canon, { now: () => '2026-09-08T10:00:00Z' })
      ).rejects.toThrow(/concurrent edit/i);
    } finally {
      (fsMod.promises as any).copyFile = originalCopyFile;
    }
    // L'apply n'a PAS écrasé la mutation externe
    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.env.INJECTED).toBe(true);
  });

  test('fichier absent : apply ensure-present crée le fichier avec les clés canon', async () => {
    const res = await applyCanonToFile(settingsPath, canon, { now: () => '2026-09-08T10:00:00Z' });
    expect(res.applied).toBe(true);
    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://relay.example');
  });

  test('exemptions machine : chemins exemptés skipped', async () => {
    writeSettings({ env: {} });
    const res = await applyCanonToFile(settingsPath, canon, {
      exemptedPaths: ['env.CLAUDE_CODE_AUTO_COMPACT_WINDOW'],
      now: () => '2026-09-08T10:00:00Z',
    });
    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(res.skipped.some(s => s.reason === 'exempté pour cette machine')).toBe(true);
  });
});

describe('findLatestClaudeSettingsSnapshot', () => {
  test('aucun snapshot => found:false (pas d exception)', async () => {
    const lookup = await findLatestClaudeSettingsSnapshot(fakeDir, 'machine-x');
    expect(lookup.found).toBe(false);
  });

  test('standalone trouvé', async () => {
    const dir = join(fakeDir, 'configs', 'machine-x', 'claude-settings');
    mkdirSync(dir, { recursive: true });
    const read = await readClaudeSettingsFileFrom(settingsPath, { env: { ANTHROPIC_BASE_URL: 'https://a' } });
    writeFileSync(join(dir, 'claude-settings.json'), JSON.stringify(buildSnapshot(read, 'machine-x', '2026-09-08T10:00:00Z')), 'utf-8');
    const lookup = await findLatestClaudeSettingsSnapshot(fakeDir, 'machine-x');
    expect(lookup.found).toBe(true);
    expect(lookup.snapshot?.harmonization['env.ANTHROPIC_BASE_URL']).toBe('https://a');
    expect(lookup.collectedAt).toBe('2026-09-08T10:00:00Z');
  });

  test('paquet versionné le plus récent gagne', async () => {
    const base = join(fakeDir, 'configs', 'machine-y');
    for (const [v, url] of [['v1.0.0-2026-09-01', 'https://old'], ['v2.0.0-2026-09-08', 'https://new']] as const) {
      const dir = join(base, v, 'claude-settings');
      mkdirSync(dir, { recursive: true });
      const read = await readClaudeSettingsFileFrom(settingsPath, { env: { ANTHROPIC_BASE_URL: url } });
      writeFileSync(join(dir, 'claude-settings.json'), JSON.stringify(buildSnapshot(read, 'machine-y', v)), 'utf-8');
    }
    const lookup = await findLatestClaudeSettingsSnapshot(fakeDir, 'machine-y');
    expect(lookup.snapshot?.harmonization['env.ANTHROPIC_BASE_URL']).toBe('https://new');
  });

  test('snapshot corrompu (non JSON) => trouvé mais ignoré, found:false', async () => {
    const dir = join(fakeDir, 'configs', 'machine-z', 'claude-settings');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claude-settings.json'), 'not json', 'utf-8');
    const lookup = await findLatestClaudeSettingsSnapshot(fakeDir, 'machine-z');
    expect(lookup.found).toBe(false);
  });
});

describe('maskSecretValue', () => {
  test('digest sans fuite', () => {
    const masked = maskSecretValue('sk-very-secret');
    expect(masked).not.toContain('very-secret');
    expect(masked).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);
    // même valeur => même digest (arbitrage « même secret des deux côtés ? »)
    expect(maskSecretValue('sk-very-secret')).toBe(masked);
    expect(maskSecretValue('')).toBe('<empty>');
    expect(maskSecretValue(undefined)).toBe('<unset>');
  });
});

describe('redactValue — non-divulgation à la frontière d observation (défaut review #1)', () => {
  test('BASE_URL avec credentials inline : userinfo masqué avec empreinte, jamais le raw', () => {
    const out = redactValue('env.ANTHROPIC_BASE_URL', 'https://user:secret@relay.example/v1');
    expect(String(out)).toMatch(/^https:\/\/<credentials:sha256=[0-9a-f]{16}>@relay\.example\/v1$/);
    expect(String(out)).not.toContain('user');
    expect(String(out)).not.toContain('secret');
  });

  test('BASE_URL avec query sensible : valeur masquée avec empreinte, le non-sensible reste', () => {
    const out = redactValue('env.ANTHROPIC_BASE_URL', 'https://relay.example/?token=abc123&channel=gpt');
    expect(String(out)).toMatch(/^https:\/\/relay\.example\/\?token=<redacted:sha256=[0-9a-f]{16}>&channel=gpt$/);
    expect(String(out)).not.toContain('abc123');
  });

  test('BASE_URL malformée : digest complet, jamais le raw', () => {
    const out = redactValue('env.ANTHROPIC_BASE_URL', 'not-a-real-url');
    expect(String(out)).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);
    expect(String(out)).not.toContain('not-a-real-url');
  });

  test('préserve le slash final d origine (pas de normalisation qui fabriquerait une conformité)', () => {
    expect(redactValue('env.ANTHROPIC_BASE_URL', 'https://relay.example')).toBe('https://relay.example');
    expect(redactValue('env.ANTHROPIC_BASE_URL', 'https://relay.example/')).toBe('https://relay.example/');
  });

  test('URL de credentials identique => redaction identique (même secret == même digest de forme)', () => {
    const a = redactValue('env.ANTHROPIC_BASE_URL', 'https://user:pw@a.example');
    const b = redactValue('env.ANTHROPIC_BASE_URL', 'https://user:pw@a.example');
    expect(a).toBe(b);
  });

  test('URL AVEC credentials vs SANS credentials restent distinctes (pas de conformité fabriquée)', () => {
    const withCred = redactValue('env.ANTHROPIC_BASE_URL', 'https://user:pw@relay.example');
    const noCred = redactValue('env.ANTHROPIC_BASE_URL', 'https://relay.example');
    expect(String(withCred)).not.toBe(String(noCred));
  });

  test('userinfo DIFFÉRENTS sur même host/path => marqueurs DIFFÉRENTS (discrimination non réversible, défaut review #1)', () => {
    const a = redactValue('env.ANTHROPIC_BASE_URL', 'https://user1:pw1@relay.example/v1');
    const b = redactValue('env.ANTHROPIC_BASE_URL', 'https://user2:pw2@relay.example/v1');
    // PAS de faux alignement : compare_config doit voir la divergence.
    expect(a).not.toBe(b);
    // host/path préservés ; les secrets ne fuient pas.
    expect(String(a)).toContain('relay.example/v1');
    expect(String(b)).toContain('relay.example/v1');
    for (const leak of ['user1', 'pw1', 'user2', 'pw2']) {
      expect(String(a)).not.toContain(leak);
      expect(String(b)).not.toContain(leak);
    }
  });

  test('valeurs de query secrètes DIFFÉRENTES => marqueurs DIFFÉRENTS (pas de conformité fabriquée)', () => {
    const a = redactValue('env.ANTHROPIC_BASE_URL', 'https://relay.example/v1?auth=zulu9');
    const b = redactValue('env.ANTHROPIC_BASE_URL', 'https://relay.example/v1?auth=omega7');
    expect(a).not.toBe(b);
    // non-divulgation : la valeur n'est attachée nulle part ('z'/'m'/'g'/'o'
    // hors alphabet hex => impossible de la retrouver dans l'empreinte).
    expect(String(a)).not.toContain('zulu9');
    expect(String(b)).not.toContain('omega7');
  });

  test('query auth/sig/api-key avec valeurs COURTES => redacted, fail-closed (défaut review #3)', () => {
    // Valeurs courtes qu'AUCUNE heuristique de contenu ne détecte — seul le
    // NOM du paramètre doit déclencher la redaction (frontière publique).
    const cases: Array<[string, string]> = [
      ['auth', '3f9b2z'],   // exemple de la revue (variante non-hex)
      ['sig', 'abz2'],
      ['api_key', 'zz9'],
      ['x-api-key', 'kx7'],
      ['access_token', 'ty1'],
    ];
    for (const [param, secretVal] of cases) {
      const out = redactValue('env.ANTHROPIC_BASE_URL', `https://relay.example/v1?${param}=${secretVal}`);
      expect(String(out), `param ${param} : valeur jamais publiée`).not.toContain(secretVal);
      expect(String(out), `param ${param} : marqueur empreinte présent`)
        .toMatch(new RegExp(`${param.replace(/[-_]/g, '[-_]')}=<redacted:sha256=[0-9a-f]{16}>`));
    }
  });

  test('param non sensible préservé tel quel (la redaction ne masque pas tout)', () => {
    const out = redactValue('env.ANTHROPIC_BASE_URL', 'https://relay.example/v1?mode=fast&auth=3f9b2z');
    expect(String(out)).toContain('mode=fast');
    expect(String(out)).not.toContain('3f9b2z');
  });

  test('design/signal/author restent lisibles — matching par MOT ENTIER, pas sous-chaîne (réserve revue passe 3)', () => {
    // Ces noms ne contiennent « sig »/« auth » que comme SOUS-CHAÎNE : la
    // sur-redaction par sous-chaîne est terminée, sans trou côté fail-closed
    // (auth reste couvert dans la même URL).
    const out = redactValue('env.ANTHROPIC_BASE_URL', 'https://relay.example/v1?design=dark&signal=high&author=jd&auth=3f9b2z');
    expect(String(out)).toContain('design=dark');
    expect(String(out)).toContain('signal=high');
    expect(String(out)).toContain('author=jd');
    expect(String(out)).not.toContain('3f9b2z');
    expect(String(out)).toMatch(/auth=<redacted:sha256=[0-9a-f]{16}>/);
  });

  test('variantes camelCase couvertes par frontière de mot (secretKey, myAuthToken)', () => {
    const out = redactValue('env.ANTHROPIC_BASE_URL', 'https://relay.example/v1?secretKey=sq7&myAuthToken=mt9');
    expect(String(out)).not.toContain('sq7');
    expect(String(out)).not.toContain('mt9');
    expect(String(out)).toMatch(/secretKey=<redacted:sha256=[0-9a-f]{16}>/);
    expect(String(out)).toMatch(/myAuthToken=<redacted:sha256=[0-9a-f]{16}>/);
  });

  test('suffixe numérique sur mot sensible couvert — token2/key2/apikey2/sig2/auth0 (régression revue passe 4)', () => {
    // La version mot-entier SANS frontière lettre↔chiffre avait régressé la
    // couverture de la version par sous-chaîne : '?token2=abc123' était
    // publié brut. Frontière lettre→chiffre => ['token','2'] => couvert.
    const cases: Array<[string, string]> = [
      ['token2', 'abz2'],
      ['key2', 'kxy9'],
      ['apikey2', 'ap7z'],
      ['sig2', 'sg5x'],
      ['auth0', 'au3w'],
    ];
    for (const [param, secretVal] of cases) {
      const out = redactValue('env.ANTHROPIC_BASE_URL', `https://relay.example/v1?${param}=${secretVal}`);
      expect(String(out), `param ${param} : valeur jamais publiée`).not.toContain(secretVal);
      expect(String(out), `param ${param} : marqueur empreinte présent`)
        .toMatch(new RegExp(`${param}=<redacted:sha256=[0-9a-f]{16}>`));
    }
    // Acquis conservés : les bénins à suffixe numérique restent lisibles.
    const benign = redactValue('env.ANTHROPIC_BASE_URL', 'https://relay.example/v1?design2=light&author3=mb&signal1=low');
    expect(String(benign)).toContain('design2=light');
    expect(String(benign)).toContain('author3=mb');
    expect(String(benign)).toContain('signal1=low');
  });

  test('idempotence : une valeur déjà redactée (nouveaux marqueurs) retournée telle quelle', () => {
    const once = redactValue('env.ANTHROPIC_BASE_URL', 'https://user:pw@relay.example/v1?auth=3f9b2z');
    expect(typeof once).toBe('string');
    const twice = redactValue('env.ANTHROPIC_BASE_URL', once as string);
    expect(twice).toBe(once); // pas de double-hash (empreinte de l'empreinte)
  });

  test('valeurs non sensibles (modèles, nombres) inchangées', () => {
    expect(redactValue('modelMap.opus', 'claude-opus-5[1m]')).toBe('claude-opus-5[1m]');
    expect(redactValue('env.CLAUDE_CODE_AUTO_COMPACT_WINDOW', 280000)).toBe(280000);
  });

  test('projectSettingsSafe redacte les BASE_URL sensibles dans le snapshot harmonization', () => {
    const p = projectSettingsSafe({
      env: { ANTHROPIC_BASE_URL: 'https://user:secret@relay.example', ANTHROPIC_API_KEY: 'sk-ant-leak' },
      model: 'sonnet',
    });
    expect(String(p['env.ANTHROPIC_BASE_URL'])).toContain('<credentials:sha256=');
    expect(String(p['env.ANTHROPIC_BASE_URL'])).not.toContain('secret');
    expect(p).not.toHaveProperty('env.ANTHROPIC_API_KEY');
    expect(p['model']).toBe('sonnet');
  });
});

describe('buildSnapshot — BASE_URL sensible jamais publiée (défaut review #1)', () => {
  test('snapshot : credentials de BASE_URL masqués, jamais dans la sérialisation', async () => {
    const read = await readClaudeSettingsFileFrom(settingsPath, {
      env: { ANTHROPIC_BASE_URL: 'https://admin:topsecret@relay.example', CLAUDE_CODE_AUTO_COMPACT_WINDOW: 280000 },
    });
    const snap = buildSnapshot(read, 'machine-x', '2026-09-08T10:00:00Z');
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('topsecret');
    expect(serialized).not.toContain('admin');
    expect(String(snap.harmonization['env.ANTHROPIC_BASE_URL'])).toContain('<credentials:sha256=');
  });
});

describe('modelMap — cartographie tier→modèle (défaut review #6)', () => {
  const settings = {
    model: 'opus',
    modelMap: { opus: 'claude-opus-5[1m]', sonnet: 'claude-sonnet-5[1m]', haiku: 'claude-haiku-4-5[1m]' },
    env: { ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5[1m]', ANTHROPIC_CUSTOM_MODEL_OPTION: 'gpt-5.6-sol' },
  };

  test('isAllowedKeyPath : les chemins modelMap.* sont allow-listés', () => {
    expect(isAllowedKeyPath('modelMap.opus')).toBe(true);
    expect(isAllowedKeyPath('modelMap.sonnet')).toBe(true);
    expect(isAllowedKeyPath('modelMap.haiku')).toBe(true);
    expect(isAllowedKeyPath('modelMap.fable')).toBe(true);
    expect(isAllowedKeyPath('modelMap.dex')).toBe(false); // tier inconnu borné
    expect(isAllowedKeyPath('env.ANTHROPIC_DEFAULT_FABLE_MODEL')).toBe(true);
    expect(isAllowedKeyPath('env.ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe(true);
    expect(isAllowedKeyPath('env.CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe(true);
  });

  test('projection : valeurs par tier extraites (contenus, pas juste le nom)', () => {
    const p = projectSettings(settings);
    expect(p['modelMap.opus']).toBe('claude-opus-5[1m]');
    expect(p['modelMap.sonnet']).toBe('claude-sonnet-5[1m]');
    expect(p['env.ANTHROPIC_DEFAULT_FABLE_MODEL']).toBe('claude-fable-5[1m]');
    expect(p['env.ANTHROPIC_CUSTOM_MODEL_OPTION']).toBe('gpt-5.6-sol');
  });

  test('canon validation : modelMap.* scalar accepté ; valeur secrète rejetée', () => {
    const base: CanonPayload = { version: 'v1', mode: 'ensure-present', keys: { 'modelMap.opus': 'claude-opus-5[1m]' } };
    expect(validateCanon(base).valid).toBe(true);
    const bad: CanonPayload = { version: 'v1', mode: 'ensure-present', keys: { 'modelMap.opus': 'sk-ant-leak' } };
    const v = validateCanon(bad);
    expect(v.valid).toBe(false);
    expect(v.problems.join()).toMatch(/secret/);
    // modelMap en tant qu objet opaque est rejeté (scalaires par tier uniquement)
    const obj: CanonPayload = { version: 'v1', mode: 'ensure-present', keys: { modelMap: { opus: 'x' } as any } };
    expect(validateCanon(obj).valid).toBe(false);
  });

  test('apply ensure-present : pose modelMap.opus, préserve les autres tiers', async () => {
    writeSettings({ modelMap: { sonnet: 'claude-sonnet-5[1m]' } });
    const canon: CanonPayload = { version: 'v1', mode: 'ensure-present', keys: { 'modelMap.opus': 'claude-opus-5[1m]' } };
    await applyCanonToFile(settingsPath, canon, { now: () => '2026-09-08T10:00:00Z' });
    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.modelMap.opus).toBe('claude-opus-5[1m]');
    expect(after.modelMap.sonnet).toBe('claude-sonnet-5[1m]'); // tier non mentionné, préservé
  });
});

/** Helper local : écrit et relit (pour réutiliser readClaudeSettingsFile sur un contenu donné). */
async function readClaudeSettingsFileFrom(path: string, content: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(content, null, 2), 'utf-8');
  return readClaudeSettingsFile(path);
}
