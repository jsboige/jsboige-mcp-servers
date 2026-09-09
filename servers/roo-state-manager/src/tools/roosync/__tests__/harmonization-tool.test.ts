/**
 * Tests du CHEMIN PUBLIC roosync_harmonization (outil enregistré) — #3545
 *
 * L'outil est servi par registry.ts (case 'roosync_harmonization') qui importe
 * ce module et stringifie son retour : on teste ici la fonction exportée telle
 * qu'appelée par le registry, avec :
 *  - MessageManager mocké (faux envois, rejouables),
 *  - ROOSYNC_SHARED_PATH / CLAUDE_SETTINGS_PATH / ROOSYNC_MACHINE_ID pointés
 *    sur des répertoires FAKE,
 *  - l'enregistrement statique (tool-definitions + TOOL_CAPABILITIES).
 *
 * Aucun service réel, aucun settings réel, aucun envoi réel.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { mockSendMessage, mockGetMessageManager } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockGetMessageManager: vi.fn(),
}));

vi.mock('../../../services/MessageManager.js', () => ({
  getMessageManager: mockGetMessageManager,
}));

import { roosyncHarmonization, HarmonizationArgsSchema } from '../harmonization.js';
import { allToolDefinitions, roosyncHarmonizationDefinition } from '../../../tools/tool-definitions.js';
import { TOOL_CAPABILITIES } from '../../../tools/registry.js';

let fakeShared: string;
let fakeHome: string;
let fakeSettings: string;
const sentByMock: Array<{ to: string; subject: string }> = [];
const savedEnv: Record<string, string | undefined> = {};
const LOCAL = 'myia-ai-01';

function args(partial: Record<string, unknown>): any {
  return partial as any;
}

beforeEach(() => {
  fakeShared = mkdtempSync(join(tmpdir(), 'harm-tool-shared-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'harm-tool-home-'));
  fakeSettings = join(fakeHome, 'settings.json');
  for (const k of ['ROOSYNC_SHARED_PATH', 'CLAUDE_SETTINGS_PATH', 'ROOSYNC_MACHINE_ID', 'ROOSYNC_WORKSPACE_ID', 'WORKSPACE_PATH']) {
    savedEnv[k] = process.env[k];
  }
  process.env.ROOSYNC_SHARED_PATH = fakeShared;
  process.env.CLAUDE_SETTINGS_PATH = fakeSettings;
  process.env.ROOSYNC_MACHINE_ID = LOCAL;
  delete process.env.ROOSYNC_WORKSPACE_ID;
  delete process.env.WORKSPACE_PATH;

  sentByMock.length = 0;
  mockSendMessage.mockImplementation(async (_from: string, to: string, subject: string) => {
    sentByMock.push({ to, subject });
    return { id: `mock-msg-${sentByMock.length}` };
  });
  mockGetMessageManager.mockReturnValue({ sendMessage: mockSendMessage });
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(fakeShared, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('Enregistrement statique (surface publique)', () => {
  test('roosync_harmonization présent dans allToolDefinitions avec schéma complet', () => {
    const def = allToolDefinitions.find(d => d.name === 'roosync_harmonization');
    expect(def).toBeDefined();
    expect(def).toBe(roosyncHarmonizationDefinition);
    const props = (def!.inputSchema as any).properties;
    expect(props.action.enum).toContain('confirm');
    expect(props.action.enum).toContain('status');
    expect(props.claimed_hash.description).toMatch(/NEVER counted/i);
  });

  test('TOOL_CAPABILITIES déclare la dépendance sharedPath', () => {
    expect(TOOL_CAPABILITIES['roosync_harmonization']).toEqual(['sharedPath']);
  });
});

describe('HarmonizationArgsSchema — refinements', () => {
  test('create sans canon/fleet rejeté', () => {
    expect(() => HarmonizationArgsSchema.parse({ action: 'create', target_file: 'claude-settings' })).toThrow();
  });
  test('status sans campaign_id rejeté', () => {
    expect(() => HarmonizationArgsSchema.parse({ action: 'status' })).toThrow();
  });
  test('list sans campaign_id accepté', () => {
    expect(HarmonizationArgsSchema.parse({ action: 'list' }).action).toBe('list');
  });
});

describe('Chemin public — cycle de vie complet (create → apply → confirm → status → close)', () => {
  const canon = {
    version: '2026.09.09-1',
    mode: 'ensure-present',
    keys: {
      'env.ANTHROPIC_BASE_URL': 'https://relay.example',
      'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW': 280000,
    },
  };

  test('contrôle positif canon du create au close, via la fonction exportée', async () => {
    // 1. create
    const created = await roosyncHarmonization(args({
      action: 'create', target_file: 'claude-settings', canon, fleet: [LOCAL, 'myia-po-2024'],
    }));
    expect(created.status).toBe('success');
    const campaignId = (created as any).campaign.id;
    expect(campaignId).toBe('hc-claude-settings-2026.09.09-1');

    // persisté dans le faux store partagé
    expect(existsSync(join(fakeShared, 'harmonization', 'campaigns', `${campaignId}.json`))).toBe(true);

    // 2. apply dry_run : aucun write
    const dry = await roosyncHarmonization(args({ action: 'apply', campaign_id: campaignId, dry_run: true }));
    expect(dry.status).toBe('success');
    expect(existsSync(fakeSettings)).toBe(false);

    // 3. apply réel : écrit le settings local (fichier absent => créé avec les clés canon)
    const applied = await roosyncHarmonization(args({ action: 'apply', campaign_id: campaignId }));
    expect(applied.status).toBe('success');
    const settings = JSON.parse(readFileSync(fakeSettings, 'utf-8'));
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('https://relay.example');
    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(280000);

    // 4. confirm : relecture live conforme
    const confirmed = await roosyncHarmonization(args({ action: 'confirm', campaign_id: campaignId }));
    expect(confirmed.status).toBe('confirmed');

    // 5. status : po-2024 en attente, local confirmé
    const st = await roosyncHarmonization(args({ action: 'status', campaign_id: campaignId }));
    expect(st.status).toBe('success');
    const machines = (st as any).machines as Array<{ recipient: string; confirmationState: string }>;
    expect(machines.find(m => m.recipient === LOCAL)?.confirmationState).toBe('confirmed');
    expect(machines.find(m => m.recipient === 'myia-po-2024')?.confirmationState).toBe('none');
    expect((st as any).summary.allConfirmed).toBe(false);

    // 6. dispatch : DM vers po-2024 uniquement (le mock ne bloque pas l'auto-message,
    //    mais on vérifie l'envoi effectif vers la machine distante)
    const dispatched = await roosyncHarmonization(args({ action: 'dispatch', campaign_id: campaignId }));
    expect(dispatched.status).toBe('success');
    expect(sentByMock.some(m => m.to === 'myia-po-2024')).toBe(true);
    expect(sentByMock.find(m => m.to === 'myia-po-2024')?.subject).toContain('[HARMONIZATION]');

    // 7. close : refusé tant que po-2024 n'a pas confirmé
    const refused = await roosyncHarmonization(args({ action: 'close', campaign_id: campaignId }));
    expect(refused.status).toBe('error');
    expect((refused as any).code).toBe('CLOSE_PRECONDITION_FAILED');

    // force + reason
    const closed = await roosyncHarmonization(args({ action: 'close', campaign_id: campaignId, force: true, reason: 'test closure' }));
    expect(closed.status).toBe('success');
  });

  test('canon avec secret rejeté au create (fail fast)', async () => {
    const bad = await roosyncHarmonization(args({
      action: 'create',
      target_file: 'claude-settings',
      canon: { version: 'x-1', mode: 'enforce-value', keys: { 'env.ANTHROPIC_API_KEY': 'sk-leak' } },
      fleet: [LOCAL],
    }));
    expect(bad.status).toBe('error');
    expect((bad as any).code).toBe('INVALID_CANON');
  });

  test('campagne inconnue => status erreur CAMPAIGN_NOT_FOUND (fail closed)', async () => {
    const r = await roosyncHarmonization(args({ action: 'status', campaign_id: 'hc-claude-settings-ghost-1' }));
    expect(r.status).toBe('error');
    expect((r as any).code).toBe('CAMPAIGN_NOT_FOUND');
  });

  test('dispatch : échec d envoi vers un destinataire => partial, non enregistré', async () => {
    const created = await roosyncHarmonization(args({
      action: 'create', target_file: 'claude-settings', canon, fleet: ['myia-po-2024', 'myia-po-2025'],
    }));
    const campaignId = (created as any).campaign.id;
    mockSendMessage.mockImplementation(async (_f: string, to: string) => {
      if (to === 'myia-po-2025') throw new Error('GDrive down');
      sentByMock.push({ to, subject: 'x' });
      return { id: 'm' };
    });
    const d = await roosyncHarmonization(args({ action: 'dispatch', campaign_id: campaignId }));
    expect(d.status).toBe('partial');
    expect((d as any).failures).toHaveLength(1);
    // rejouable : le destinataire en échec repart au prochain dispatch
    mockSendMessage.mockImplementation(async (_f: string, to: string) => {
      sentByMock.push({ to, subject: 'x' });
      return { id: 'm2' };
    });
    const d2 = await roosyncHarmonization(args({ action: 'dispatch', campaign_id: campaignId }));
    expect((d2 as any).sent.some((s: any) => s.to === 'myia-po-2025')).toBe(true);
  });
});

describe('apply — la machine locale uniquement, sans toucher au distant', () => {
  test('apply ne crée AUCUN fichier hors du settings local', async () => {
    const created = await roosyncHarmonization(args({
      action: 'create', target_file: 'claude-settings',
      canon: { version: 'local-only-1', mode: 'ensure-present', keys: { 'model': 'sonnet' } },
      fleet: ['myia-po-2024'],
    }));
    const campaignId = (created as any).campaign.id;
    await roosyncHarmonization(args({ action: 'apply', campaign_id: campaignId }));
    expect(existsSync(fakeSettings)).toBe(true);
    // le store distant n'a pas de settings de po-2024
    expect(existsSync(join(fakeShared, 'configs', 'myia-po-2024'))).toBe(false);
  });
});
