/**
 * Tests HarmonizationCampaignService — #3545
 *
 * Exigences de l'issue vérifiées ici :
 *  - canon immuable/versionné, hash lié aux confirmations
 *  - dispatch machine:workspace idempotent, échecs jamais marqués envoyés
 *  - confirmations : relecture LIVE prime, claimed hash jamais compté,
 *    invalidées par changement de canon (nouvelle campagne) ou drift observé
 *  - relances idempotentes (cooldown), échecs d'envoi pas comptés
 *  - re-détection de drift (local live vs canon ; distant snapshot vs canon)
 *  - close gated sur les confirmations valides
 *  - fail closed : campagne introuvable => erreur
 *
 * Faux store (tmpdir), faux sendMessage, fausse horloge — aucun service réel.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  HarmonizationCampaignService,
  SendMessageFn,
  CreateCampaignInput,
  CampaignServiceDeps,
  COORDINATOR_LOCK_TTL_MS,
} from '../HarmonizationCampaignService.js';
import { buildSnapshot, readClaudeSettingsFile, hashProjection, projectSettings } from '../ClaudeSettingsService.js';

let fakeShared: string;
let fakeHome: string;
let fakeSettings: string;
let sentMessages: Array<{ from: string; to: string; subject: string; body: string; tags?: string[] }>;
let failSendFor: Set<string>;
let clockMs: number;
let seq: number;

const sendMessage: SendMessageFn = async (from, to, subject, body, _priority, tags) => {
  if (failSendFor.has(to)) {
    throw new Error(`simulated send failure to ${to}`);
  }
  sentMessages.push({ from, to, subject, body, tags });
  return { id: `msg-${++seq}` };
};

function makeService(
  machineId = 'myia-ai-01',
  extra: Partial<CampaignServiceDeps> = {}
): HarmonizationCampaignService {
  return new HarmonizationCampaignService({
    sharedStatePath: fakeShared,
    machineId,
    settingsPath: fakeSettings,
    fromFullId: `${machineId}:roo-extensions`,
    sendMessage,
    now: () => new Date(clockMs),
    ...extra,
  });
}

function defaultCanonInput(): CreateCampaignInput {
  return {
    targetFile: 'claude-settings',
    canon: {
      version: '2026.09.08-1',
      mode: 'ensure-present',
      keys: {
        'env.ANTHROPIC_BASE_URL': 'https://relay.example',
        'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW': 280000,
      },
    },
    fleet: ['myia-po-2023:roo-extensions', 'myia-po-2024'],
  };
}

function writeLocalSettings(content: unknown): void {
  mkdirSync(join(fakeSettings, '..'), { recursive: true });
  writeFileSync(fakeSettings, JSON.stringify(content, null, 2), 'utf-8');
}

/** Publie un snapshot claude-settings pour une machine distante dans le faux store. */
async function publishSnapshot(machineId: string, settingsContent: unknown, collectedAt: string): Promise<void> {
  const read = await readClaudeSettingsFile(fakeSettings);
  // buildSnapshot lit via read result — on construit directement le même format
  const snapshot = buildSnapshot(
    { state: 'ok', settings: settingsContent as Record<string, unknown>, contentHash: 'x' },
    machineId,
    collectedAt
  );
  const dir = join(fakeShared, 'configs', machineId, 'claude-settings');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'claude-settings.json'), JSON.stringify(snapshot), 'utf-8');
}

beforeEach(() => {
  fakeShared = mkdtempSync(join(tmpdir(), 'harm-campaign-shared-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'harm-campaign-home-'));
  fakeSettings = join(fakeHome, 'settings.json');
  // settings local absent par défaut (machine coordinatrice sans apply)
  sentMessages = [];
  failSendFor = new Set();
  clockMs = Date.parse('2026-09-08T12:00:00Z');
  seq = 0;
});

/** Lit les événements immuables d'une machine (confirmations + échecs). */
function readEvents(campaignId: string, machine: string): Array<Record<string, unknown>> {
  const dir = join(fakeShared, 'harmonization', 'campaigns', campaignId, 'events', machine);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(e => e.endsWith('.json'))
    .map(e => JSON.parse(readFileSync(join(dir, e), 'utf-8')) as Record<string, unknown>);
}

function readConfirmations(campaignId: string, machine: string): Array<Record<string, unknown>> {
  return readEvents(campaignId, machine).filter(e => e.kind === 'confirm');
}

/** Chemin du verrou coordinateur d'une campagne (défaut review #2). */
function lockPathOf(campaignId: string): string {
  return join(fakeShared, 'harmonization', 'campaigns', `${campaignId}.lock`);
}

/**
 * Écrit un verrou coordinateur valide (simule un détenteur existant — frais
 * ou crashé selon `acquiredAgoMs` vs COORDINATOR_LOCK_TTL_MS).
 */
function writeCoordinatorLock(campaignId: string, token: string, acquiredAgoMs: number): void {
  mkdirSync(join(fakeShared, 'harmonization', 'campaigns'), { recursive: true });
  const acquiredMs = clockMs - acquiredAgoMs;
  writeFileSync(lockPathOf(campaignId), JSON.stringify({
    owner: 'myia-ai-01',
    token,
    acquiredAt: new Date(acquiredMs).toISOString(),
    expiresAt: new Date(acquiredMs + COORDINATOR_LOCK_TTL_MS).toISOString(),
  }), 'utf-8');
}

afterEach(() => {
  rmSync(fakeShared, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('createCampaign', () => {
  test('contrôle positif : canon valide + fleet => campagne persistée avec hash', async () => {
    const svc = makeService();
    const rec = await svc.createCampaign(defaultCanonInput());
    expect(rec.id).toBe('hc-claude-settings-2026.09.08-1');
    expect(rec.canon.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.status).toBe('active');
    // persisté
    const onDisk = JSON.parse(readFileSync(join(fakeShared, 'harmonization', 'campaigns', `${rec.id}.json`), 'utf-8'));
    expect(onDisk.canon.version).toBe('2026.09.08-1');
  });

  test('canon invalide rejeté (chemin non allow-listé)', async () => {
    const svc = makeService();
    const input = defaultCanonInput();
    (input.canon.keys as any)['permissions.allow'] = ['x'];
    await expect(svc.createCampaign(input)).rejects.toThrow(/Canon invalide/);
  });

  test('immuabilité : même version => CANON_IMMUTABLE, pas d écrasement', async () => {
    const svc = makeService();
    await svc.createCampaign(defaultCanonInput());
    const input2 = defaultCanonInput();
    (input2.canon.keys as any)['env.API_TIMEOUT_MS'] = 60000;
    await expect(svc.createCampaign(input2)).rejects.toThrow(/immuable/i);
    // la campagne d'origine est intacte
    const rec = await svc.getCampaign('hc-claude-settings-2026.09.08-1');
    expect(Object.keys(rec.canon.keys)).not.toContain('env.API_TIMEOUT_MS');
  });

  test('exception hors fleet rejetée ; chemin d exception non allow-listé rejeté', async () => {
    const svc = makeService();
    await expect(
      svc.createCampaign({ ...defaultCanonInput(), exceptions: { 'unknown-machine': ['model'] } })
    ).rejects.toThrow(/hors fleet/);
    await expect(
      svc.createCampaign({ ...defaultCanonInput(), exceptions: { 'myia-po-2023': ['permissions.allow'] } })
    ).rejects.toThrow(/non allow-listé/);
  });
});

describe('dispatch', () => {
  test('envoie un DM par destinataire machine:workspace, idempotent sans force', async () => {
    const svc = makeService();
    const rec = await svc.createCampaign(defaultCanonInput());
    const r1 = await svc.dispatch(rec.id);
    expect(r1.sent).toHaveLength(2);
    expect(sentMessages.map(m => m.to).sort()).toEqual(['myia-po-2023:roo-extensions', 'myia-po-2024']);
    expect(sentMessages[0].subject).toContain('[HARMONIZATION]');
    expect(sentMessages[0].body).toContain('roosync_harmonization');
    expect(sentMessages[0].body).toContain('ensure-present');

    const r2 = await svc.dispatch(rec.id);
    expect(r2.sent).toHaveLength(0);
    expect(r2.skipped).toHaveLength(2);
    expect(sentMessages).toHaveLength(2);

    // force => renvoi
    const r3 = await svc.dispatch(rec.id, { force: true });
    expect(r3.sent).toHaveLength(2);
  });

  test('échec d envoi : pas marqué dispatché, rejouable', async () => {
    const svc = makeService();
    const rec = await svc.createCampaign(defaultCanonInput());
    failSendFor.add('myia-po-2024');
    const r = await svc.dispatch(rec.id);
    expect(r.sent).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
    const after = await svc.getCampaign(rec.id);
    expect(after.dispatches['myia-po-2024']).toBeUndefined();

    // le destinataire en échec reste dispatchable
    failSendFor.clear();
    const r2 = await svc.dispatch(rec.id);
    expect(r2.sent.map(s => s.to)).toContain('myia-po-2024');
  });
});

describe('confirm — la relecture live prime', () => {
  test('mismatch : projection locale diverge => failedAttempt, PAS de confirmation', async () => {
    const svc = makeService();
    const rec = await svc.createCampaign(defaultCanonInput());
    writeLocalSettings({ env: { ANTHROPIC_BASE_URL: 'https://autre.example' } });
    const r = await svc.confirm(rec.id);
    expect(r.status).toBe('mismatch');
    // Preuve participant IMMUABLE : aucun événement 'confirm', un événement 'failed'.
    expect(readConfirmations(rec.id, 'myia-ai-01')).toHaveLength(0);
    expect(readEvents(rec.id, 'myia-ai-01').filter(e => e.kind === 'failed')).toHaveLength(1);
  });

  test('claimed_hash conforme mais live divergent => jamais compté comme confirmation', async () => {
    const svc = makeService();
    const rec = await svc.createCampaign(defaultCanonInput());
    writeLocalSettings({ env: { ANTHROPIC_BASE_URL: 'https://autre.example' } });
    const r = await svc.confirm(rec.id, { claimedHash: rec.canon.hash });
    expect(r.status).toBe('mismatch');
    expect(r.detail).toMatch(/claim/i);
    expect(readConfirmations(rec.id, 'myia-ai-01')).toHaveLength(0);
  });

  test('settings local illisible => unreadable, pas de confirmation', async () => {
    const svc = makeService();
    const rec = await svc.createCampaign(defaultCanonInput());
    mkdirSync(join(fakeSettings, '..'), { recursive: true });
    writeFileSync(fakeSettings, '{broken', 'utf-8');
    const r = await svc.confirm(rec.id);
    expect(r.status).toBe('unreadable');
  });

  test('contrôle positif canon : apply puis confirm => confirmed, hash lié', async () => {
    const svc = makeService();
    const rec = await svc.createCampaign(defaultCanonInput());
    writeLocalSettings({ env: {}, model: 'sonnet' });
    await svc.apply(rec.id);
    const r = await svc.confirm(rec.id);
    expect(r.status).toBe('confirmed');
    expect(r.observedHash).toBe(rec.canon.hash);
    const after = readConfirmations(rec.id, 'myia-ai-01');
    expect(after).toHaveLength(1);
    expect(after[0].canonHash).toBe(rec.canon.hash);
    expect(after[0].source).toBe('live-read'); // hash lié + relecture live uniquement
  });

  test('exceptions machine honorées dans la projection de confirmation', async () => {
    const svc = makeService('myia-po-2023');
    const input = defaultCanonInput();
    input.fleet = ['myia-po-2023'];
    input.exceptions = { 'myia-po-2023': ['env.CLAUDE_CODE_AUTO_COMPACT_WINDOW'] };
    const rec = await svc.createCampaign(input);
    // la machine a une fenêtre DIFFÉRENTE (exemption) et pas de BASE_URL
    writeLocalSettings({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 200000 } });
    await svc.apply(rec.id); // pose BASE_URL (fenêtre exemptée → skip)
    const r = await svc.confirm(rec.id);
    expect(r.status).toBe('confirmed');
    const after = JSON.parse(readFileSync(fakeSettings, 'utf-8'));
    expect(after.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(200000); // exempté, préservé
  });
});

describe('concurrence — preuve participant immuable (défaut #2)', () => {
  test('deux confirmations simultanées sur la même machine => deux événements distincts, aucune perte', async () => {
    const svc = makeService('myia-po-2023');
    const input = defaultCanonInput();
    input.fleet = ['myia-po-2023'];
    const rec = await svc.createCampaign(input);
    writeLocalSettings({ env: {} });
    await svc.apply(rec.id);
    // Deux "sessions" confirment en parallèle. PAS de read-modify-write partagé
    // sur le record : chaque confirmation écrit un événement immuable.
    await Promise.all([svc.confirm(rec.id), svc.confirm(rec.id)]);
    const confirms = readConfirmations(rec.id, 'myia-po-2023');
    expect(confirms).toHaveLength(2);
    expect(confirms[0].eventId).not.toBe(confirms[1].eventId);
  });

  test('confirmations d hôtes distincts : les événements sont disjoints, pas d effacement croisé', async () => {
    const svc = makeService('myia-ai-01');
    const input = defaultCanonInput();
    input.fleet = ['myia-po-2023', 'myia-po-2024'];
    const rec = await svc.createCampaign(input);
    // po-2023 et po-2024 confirment (deux services, mêmes settings conforme)
    writeLocalSettings({ env: {} });
    const svc23 = makeService('myia-po-2023');
    await svc23.apply(rec.id);
    await svc23.confirm(rec.id);
    const svc24 = makeService('myia-po-2024');
    await svc24.apply(rec.id);
    await svc24.confirm(rec.id);
    expect(readConfirmations(rec.id, 'myia-po-2023')).toHaveLength(1);
    expect(readConfirmations(rec.id, 'myia-po-2024')).toHaveLength(1);
  });

  test('mutation coordinateur sous verrou : un dispatch concurrent est refusé (CONCURRENT_WRITE) — lock FRAIS', async () => {
    const svc = makeService('myia-ai-01');
    const rec = await svc.createCampaign(defaultCanonInput());
    // Verrou FRAIS posé par une "autre session" du propriétaire (acquis il y a
    // 1 min, TTL 30 min — péremption non atteinte) => la mutation est refusée.
    writeCoordinatorLock(rec.id, 'other-session-token', 60_000);
    await expect(svc.dispatch(rec.id)).rejects.toThrow(/concurrent/i);
    // verrou relâché => dispatch passe (aucune perte silencieuse).
    rmSync(lockPathOf(rec.id), { force: true });
    const r = await svc.dispatch(rec.id);
    expect(r.sent).toHaveLength(2);
  });

  test('verrou coordinateur PÉRIMÉ (détenteur crashé) => RÉCUPÉRÉ, plus de blocage permanent (défaut review #2)', async () => {
    const svc = makeService('myia-ai-01');
    const rec = await svc.createCampaign(defaultCanonInput());
    // Détenteur killé/OOM après acquisition, jamais passé au finally :
    // lock acquis il y a TTL+1 ms — périmé au regard de la politique explicite.
    writeCoordinatorLock(rec.id, 'crashed-holder', COORDINATOR_LOCK_TTL_MS + 1);
    // La mutation du nouveau détenteur passe (récupération du lock périmé).
    const r = await svc.dispatch(rec.id);
    expect(r.sent).toHaveLength(2);
    // Le lock de récupération a été relâché proprement en finally (token match).
    expect(existsSync(lockPathOf(rec.id))).toBe(false);
  });

  test('le détenteur précédent ne peut PAS supprimer le lock du nouveau détenteur (release par token, défaut review #2)', async () => {
    const svc = makeService('myia-ai-01');
    const rec = await svc.createCampaign(defaultCanonInput());
    const lockPath = lockPathOf(rec.id);
    // Détenteur A crashé : lock périmé.
    writeCoordinatorLock(rec.id, 'token-A-crashed', COORDINATOR_LOCK_TTL_MS + 1);
    // Nouveau détenteur B récupère le lock périmé (token B généré).
    const releaseB = await (svc as any).acquireCoordinatorLock(rec.id);
    const lockB = JSON.parse(readFileSync(lockPath, 'utf-8')) as { token: string };
    expect(lockB.token).not.toBe('token-A-crashed');
    // Le détenteur A "ressuscite" et exécute SON finally de release.
    await (svc as any).releaseCoordinatorLock(lockPath, 'token-A-crashed');
    // Le lock de B est INTACT — le release de A est un no-op.
    const stillB = JSON.parse(readFileSync(lockPath, 'utf-8')) as { token: string };
    expect(stillB.token).toBe(lockB.token);
    // Le release de B supprime bien SON propre lock.
    await releaseB();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('récupération CONCURRENTE du même lock périmé : exactement 1 succès + 1 CONCURRENT_WRITE (revue passe 3)', async () => {
    const svcA = makeService('myia-ai-01');
    const rec = await svcA.createCampaign(defaultCanonInput());
    // Lock périmé (détenteur crashé) observé SIMULTANÉMENT par deux sessions
    // du même propriétaire (cron + interactive).
    writeCoordinatorLock(rec.id, 'token-stale', COORDINATOR_LOCK_TTL_MS + 1);
    const svcB = makeService('myia-ai-01');
    const results = await Promise.allSettled([
      (svcA as any).acquireCoordinatorLock(rec.id),
      (svcB as any).acquireCoordinatorLock(rec.id),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect([reason.code, reason.message].join(' ')).toMatch(/CONCURRENT_WRITE|concurrent/i);
    // Le gagnant détient un lock frais à SON token (pas celui du périmé).
    const lockAfter = JSON.parse(readFileSync(lockPathOf(rec.id), 'utf-8')) as { token: string };
    expect(lockAfter.token).not.toBe('token-stale');
    // Le libérer supprime bien le lock ; aucune quarantaine orpheline.
    const releaseWinner = (fulfilled[0] as PromiseFulfilledResult<() => Promise<void>>).value;
    await releaseWinner();
    expect(existsSync(lockPathOf(rec.id))).toBe(false);
    const campaignsDir = join(fakeShared, 'harmonization', 'campaigns');
    expect(readdirSync(campaignsDir).filter(f => f.includes('.stale-') || f.includes('.rm-'))).toEqual([]);
  });

  test('récupération adverse : un autre récupérateur qui complète dans la fenêtre garde son lock, nous refusons (revue passe 3)', async () => {
    const svc = makeService('myia-ai-01');
    const rec = await svc.createCampaign(defaultCanonInput());
    const lockPath = lockPathOf(rec.id);
    writeCoordinatorLock(rec.id, 'token-stale', COORDINATOR_LOCK_TTL_MS + 1);
    // A lit le lock périmé, puis B complète une récupération ENTIÈRE dans la
    // fenêtre lecture→détachement de A (l'entrelacement que l'unlink nu ou le
    // rename last-writer-wins ne ferment pas).
    const holderB: Array<() => Promise<void>> = [];
    const svcA = makeService('myia-ai-01', {
      _testInterposeAfterStaleRead: async () => {
        const svcB = makeService('myia-ai-01');
        holderB.push(await (svcB as any).acquireCoordinatorLock(rec.id));
      },
    });
    await expect((svcA as any).acquireCoordinatorLock(rec.id)).rejects.toThrow(/remplacé|concurrent/i);
    // Le lock de B est INTACT (restauré, jamais supprimé par A).
    const after = JSON.parse(readFileSync(lockPath, 'utf-8')) as { token: string };
    expect(after.token).not.toBe('token-stale');
    expect(after.token).toBeTruthy();
    // Aucune quarantaine orpheline ; le release de B fonctionne.
    const campaignsDir = join(fakeShared, 'harmonization', 'campaigns');
    expect(readdirSync(campaignsDir).filter(f => f.includes('.stale-') || f.includes('.rm-'))).toEqual([]);
    await holderB[0]();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('release TOCTOU : un lock REMPLACÉ entre lecture et suppression n est JAMAIS supprimé (revue passe 3)', async () => {
    const svc = makeService('myia-ai-01');
    const rec = await svc.createCampaign(defaultCanonInput());
    const lockPath = lockPathOf(rec.id);
    // Détenteur A en place (lock encore frais au moment de SA lecture).
    writeCoordinatorLock(rec.id, 'token-A', 60_000);
    // La release de A lit SON token (match), puis le lock est REMPLACÉ par
    // celui de B (récupération post-TTL) exactement dans la fenêtre
    // lecture→suppression — l'ancien protocole supprimait le lock de B.
    const svcA = makeService('myia-ai-01', {
      _testInterposeRelease: async () => {
        writeCoordinatorLock(rec.id, 'token-B-new', 60_000);
      },
    });
    await (svcA as any).releaseCoordinatorLock(lockPath, 'token-A');
    // Le lock de B SURVIT (détaché puis restauré par link conditionnel).
    const after = JSON.parse(readFileSync(lockPath, 'utf-8')) as { token: string };
    expect(after.token).toBe('token-B-new');
    // Aucune quarantaine orpheline.
    const campaignsDir = join(fakeShared, 'harmonization', 'campaigns');
    expect(readdirSync(campaignsDir).filter(f => f.includes('.stale-') || f.includes('.rm-'))).toEqual([]);
  });

  test('mutation coordinateur : le propriétaire seul peut exécuter (ownership)', async () => {
    const svc = makeService('myia-ai-01');
    const rec = await svc.createCampaign(defaultCanonInput());
    const svcOther = makeService('myia-po-2024');
    await expect(svcOther.dispatch(rec.id)).rejects.toThrow(/appartient à|propriétaire/i);
  });
});

describe('remind — idempotence et échecs', () => {
  test('machines confirmées skipped ; cooldown respecté ; échec pas compté', async () => {
    const svc = makeService('myia-ai-01');
    const input = defaultCanonInput();
    input.fleet = ['myia-po-2023', 'myia-po-2024'];
    const rec = await svc.createCampaign(input);
    await svc.dispatch(rec.id);

    // myia-po-2023 confirme (on simule depuis SA machine)
    const svcPo23 = makeService('myia-po-2023');
    writeLocalSettings({ env: {} });
    await svcPo23.apply(rec.id);
    await svcPo23.confirm(rec.id);

    // relance : po-2023 skipped (confirmé), po-2024 relancé
    const r1 = await svc.remind(rec.id, { cooldownHours: 12 });
    expect(r1.sent.map(s => s.to)).toEqual(['myia-po-2024']);
    expect(r1.skipped.some(s => s.reason === 'confirmé')).toBe(true);

    // re-relance immédiate : cooldown => skipped
    const r2 = await svc.remind(rec.id, { cooldownHours: 12 });
    expect(r2.sent).toHaveLength(0);
    expect(r2.skipped.some(s => s.reason.includes('cooldown'))).toBe(true);

    // après cooldown (avance l'horloge de 13h) : nouvelle relance possible
    clockMs += 13 * 60 * 60 * 1000;
    failSendFor.add('myia-po-2024');
    const r3 = await svc.remind(rec.id, { cooldownHours: 12 });
    expect(r3.sent).toHaveLength(0);
    expect(r3.failures).toHaveLength(1);
    // échec non enregistré : le cooldown ne bouge pas
    const afterFail = await svc.getCampaign(rec.id);
    expect(afterFail.reminders['myia-po-2024']).toHaveLength(1);
    // envoi rétabli => relance part (le dernier SUCCÈS date de >12h)
    failSendFor.clear();
    const r4 = await svc.remind(rec.id, { cooldownHours: 12 });
    expect(r4.sent.map(s => s.to)).toEqual(['myia-po-2024']);
  });
});

describe('status — re-détection de drift', () => {
  test('local : drift après confirmation détecté (live diverge) — la confirmation historique ne compte plus', async () => {
    const svc = makeService('myia-po-2023');
    const input = defaultCanonInput();
    input.fleet = ['myia-po-2023'];
    const rec = await svc.createCampaign(input);
    writeLocalSettings({ env: {} });
    await svc.apply(rec.id);
    await svc.confirm(rec.id);

    // la machine change son settings après confirmation (drift réel)
    writeLocalSettings({ env: { ANTHROPIC_BASE_URL: 'https://drift.example', CLAUDE_CODE_AUTO_COMPACT_WINDOW: 280000 } });
    const st = await svc.status(rec.id);
    expect(st.machines[0].alignment).toBe('drifted');
    // défaut #3 : un état courant drifté => la confirmation historique ne compte PAS
    expect(st.machines[0].state).toBe('drifted');
    expect(st.machines[0].confirmationState).toBe('mismatch-latest');
    expect(st.summary.confirmed).toBe(0);
    expect(st.summary.allConfirmed).toBe(false);
  });

  test('confirm-then-missing : fichier local supprimé => état disjoint missing, pas confirmé', async () => {
    const svc = makeService('myia-po-2023');
    const input = defaultCanonInput();
    input.fleet = ['myia-po-2023'];
    const rec = await svc.createCampaign(input);
    writeLocalSettings({ env: {} });
    await svc.apply(rec.id);
    await svc.confirm(rec.id);
    // suppression du fichier local après confirmation
    rmSync(fakeSettings, { force: true });
    const st = await svc.status(rec.id);
    expect(st.machines[0].state).toBe('missing');
    expect(st.summary.confirmed).toBe(0);
    expect(st.summary.allConfirmed).toBe(false);
  });

  test('confirm-then-invalid : fichier local cassé => état disjoint unreadable, pas confirmé', async () => {
    const svc = makeService('myia-po-2023');
    const input = defaultCanonInput();
    input.fleet = ['myia-po-2023'];
    const rec = await svc.createCampaign(input);
    writeLocalSettings({ env: {} });
    await svc.apply(rec.id);
    await svc.confirm(rec.id);
    // fichier local corrompu après confirmation
    writeFileSync(fakeSettings, '{broken', 'utf-8');
    const st = await svc.status(rec.id);
    expect(st.machines[0].state).toBe('unreadable');
    expect(st.summary.confirmed).toBe(0);
    expect(st.summary.allConfirmed).toBe(false);
  });

  test('distant : drift via snapshot publié post-confirmation ; snapshot antérieur => snapshot-stale', async () => {
    const svc = makeService('myia-ai-01');
    const input = defaultCanonInput();
    input.fleet = ['myia-po-2023'];
    const rec = await svc.createCampaign(input);

    // pas de snapshot distant => no-snapshot / inconnu
    let st = await svc.status(rec.id);
    expect(st.machines[0].alignment).toBe('no-snapshot');

    // snapshot conforme + confirmation de po-2023
    await publishSnapshot('myia-po-2023', {
      env: { ANTHROPIC_BASE_URL: 'https://relay.example', CLAUDE_CODE_AUTO_COMPACT_WINDOW: 280000 },
    }, '2026-09-08T11:00:00Z');
    const svcPo23 = makeService('myia-po-2023');
    writeLocalSettings({ env: {} });
    await svcPo23.apply(rec.id);
    await svcPo23.confirm(rec.id); // confirmedAt = 12:00 > snapshot 11:00 => snapshot-stale (live inconnu)

    st = await svc.status(rec.id);
    expect(st.machines[0].alignment).toBe('snapshot-stale');

    // un NOUVEAU snapshot post-confirmation divergent => drifted + confirmation invalidée
    await publishSnapshot('myia-po-2023', {
      env: { ANTHROPIC_BASE_URL: 'https://drift.example', CLAUDE_CODE_AUTO_COMPACT_WINDOW: 280000 },
    }, '2026-09-08T13:00:00Z');
    st = await svc.status(rec.id);
    expect(st.machines[0].alignment).toBe('drifted');
    expect(st.machines[0].confirmationState).toBe('mismatch-latest');
    expect(st.summary.drifted).toBe(1);
    expect(st.summary.allConfirmed).toBe(false);
  });

  test('distant conforme post-confirmation => aligned + allConfirmed', async () => {
    const svc = makeService('myia-ai-01');
    const input = defaultCanonInput();
    input.fleet = ['myia-po-2023'];
    const rec = await svc.createCampaign(input);

    const svcPo23 = makeService('myia-po-2023');
    writeLocalSettings({ env: {} });
    await svcPo23.apply(rec.id);
    await svcPo23.confirm(rec.id); // 12:00

    await publishSnapshot('myia-po-2023', {
      env: { ANTHROPIC_BASE_URL: 'https://relay.example', CLAUDE_CODE_AUTO_COMPACT_WINDOW: 280000 },
    }, '2026-09-08T14:00:00Z');

    const st = await svc.status(rec.id);
    expect(st.machines[0].alignment).toBe('aligned');
    expect(st.summary.allConfirmed).toBe(true);
  });
});

describe('close — gating', () => {
  test('refus sans confirmations complètes ; force+reason requis', async () => {
    const svc = makeService();
    const rec = await svc.createCampaign(defaultCanonInput());
    await expect(svc.close(rec.id)).rejects.toThrow(/Fermeture refusée/);
    await expect(svc.close(rec.id, { force: true })).rejects.toThrow(/force=true \+ reason/);
    const closed = await svc.close(rec.id, { force: true, reason: 'campagne pilote #3544 clôturée manuellement' });
    expect(closed.status).toBe('closed');
    // dispatch/relance refusés sur campagne fermée
    await expect(svc.dispatch(rec.id)).rejects.toThrow(/fermée/);
    await expect(svc.remind(rec.id)).rejects.toThrow(/fermée/);
    // confirm refusé sur campagne fermée (défaut review mineur) : une
    // confirmation ne s'accumule pas sur une campagne close.
    await expect(svc.confirm(rec.id)).rejects.toThrow(/fermée/);
  });

  test('fermeture propre quand toute la flotte est confirmée', async () => {
    const svc = makeService('myia-po-2023');
    const input = defaultCanonInput();
    input.fleet = ['myia-po-2023'];
    const rec = await svc.createCampaign(input);
    writeLocalSettings({ env: {} });
    await svc.apply(rec.id);
    await svc.confirm(rec.id);
    const closed = await svc.close(rec.id);
    expect(closed.status).toBe('closed');
    expect(closed.closeReason).toMatch(/entièrement confirmée/);
  });
});

describe('fail closed', () => {
  test('campagne introuvable => CAMPAIGN_NOT_FOUND (pas de mode dégradé)', async () => {
    const svc = makeService();
    await expect(svc.status('hc-claude-settings-inexistant-1')).rejects.toThrow(/introuvable/i);
    await expect(svc.apply('hc-claude-settings-inexistant-1')).rejects.toThrow(/introuvable/i);
  });

  test('id de campagne invalide rejeté (pas de path traversal)', async () => {
    const svc = makeService();
    await expect(svc.getCampaign('../../etc/passwd')).rejects.toThrow(/id de campagne invalide/i);
  });
});

describe('loadActiveExceptions (compare)', () => {
  test('fusionne les exceptions des campagnes actives, ignore les fermées', async () => {
    const svc = makeService();
    const input = defaultCanonInput();
    input.exceptions = { 'myia-po-2023': ['model'] };
    await svc.createCampaign(input);

    const input2 = defaultCanonInput();
    input2.canon = { ...input2.canon, version: '2026.09.08-2' };
    input2.fleet = ['myia-po-2023', 'myia-po-2024'];
    input2.exceptions = { 'myia-po-2023': ['env.API_TIMEOUT_MS'], 'myia-po-2024': ['model'] };
    const rec2 = await svc.createCampaign(input2);

    const exceptions = await HarmonizationCampaignService.loadActiveExceptions(fakeShared, 'claude-settings');
    expect(exceptions.byMachine['myia-po-2023'].sort()).toEqual(['env.API_TIMEOUT_MS', 'model']);
    expect(exceptions.byMachine['myia-po-2024']).toEqual(['model']);
    expect(exceptions.conflicts).toHaveLength(0); // aucun chemin requis par un canon => pas de conflit

    // campagne fermée => ses exceptions disparaissent
    const svcPo24 = makeService('myia-po-2024');
    writeLocalSettings({ env: { ANTHROPIC_BASE_URL: 'https://relay.example', CLAUDE_CODE_AUTO_COMPACT_WINDOW: 280000 } });
    await svcPo24.confirm(rec2.id);
    await svc.close(rec2.id, { force: true, reason: 'nettoyage test : seule po-2024 confirmée' });
    const exceptions2 = await HarmonizationCampaignService.loadActiveExceptions(fakeShared, 'claude-settings');
    expect(exceptions2.byMachine['myia-po-2024']).toBeUndefined();
    expect(exceptions2.byMachine['myia-po-2023']).toBeDefined();
  });

  test('conflit détecté : chemin exempté par une campagne mais requis (canon) par une autre', async () => {
    const svc = makeService('myia-ai-01');
    const base = defaultCanonInput();
    // campagne 1 exige BASE_URL (dans le canon) pour po-2023
    await svc.createCampaign(base);
    // campagne 2 exempte BASE_URL pour po-2023
    const c2 = defaultCanonInput();
    c2.canon = { ...c2.canon, version: '2026.09.08-2' };
    c2.fleet = ['myia-po-2023'];
    c2.exceptions = { 'myia-po-2023': ['env.ANTHROPIC_BASE_URL'] };
    await svc.createCampaign(c2);

    const res = await HarmonizationCampaignService.loadActiveExceptions(fakeShared, 'claude-settings');
    // BASE_URL requis par la campagne 1 => PAS une exemption effective
    expect(res.byMachine['myia-po-2023'] || []).not.toContain('env.ANTHROPIC_BASE_URL');
    const conflict = res.conflicts.find(c => c.path === 'env.ANTHROPIC_BASE_URL');
    expect(conflict).toBeDefined();
    expect(conflict!.requiredBy).toContain('hc-claude-settings-2026.09.08-1');
    expect(conflict!.exemptedBy).toContain('hc-claude-settings-2026.09.08-2');
  });
});
