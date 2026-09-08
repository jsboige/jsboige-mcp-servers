/**
 * #3537 §6.4 — une clé de dashboard naît implicitement de la première écriture
 * qui la nomme. Rien n'échoue, un espace de noms inédit apparaît, et aucun
 * lecteur ne l'apprend. Ces tests verrouillent le fait que la création est
 * BRUYANTE, et qu'elle porte de quoi identifier l'écrivain fautif.
 *
 * Contre-épreuve incluse : sans le WARN dans la fabrique, le premier test
 * rougit (aucun appel enregistré) — le test distingue donc bien « garde
 * présente » de « garde absente », et pas seulement « le code ne jette pas ».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const warn = vi.fn();
vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() })),
}));

const { createEmptyDashboard } = await import('../dashboard.js');

const author = { machineId: 'myia-ai-01', workspace: 'roo-extensions' };

describe('createEmptyDashboard — WARN sur clé neuve (#3537 §6.4)', () => {
  beforeEach(() => { warn.mockClear(); });

  it('journalise un WARN identifiable quand un espace de noms est créé', () => {
    createEmptyDashboard('workspace', 'workspace-CoursIA (1)', author);

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0];
    expect(message).toContain('[NEW-KEY]');
    expect(message).toContain('workspace-CoursIA (1)');
    expect(meta).toMatchObject({
      key: 'workspace-CoursIA (1)',
      type: 'workspace',
      machineId: 'myia-ai-01',
      workspace: 'roo-extensions',
    });
  });

  it('porte l’écrivain — sans lui le WARN ne désigne personne', () => {
    createEmptyDashboard('machine', 'machine-myia-po-2025', {
      machineId: 'myia-po-2025', workspace: 'CoursIA',
    });

    expect(warn.mock.calls[0][1]).toMatchObject({
      machineId: 'myia-po-2025', workspace: 'CoursIA',
    });
  });

  it('reste une fabrique pure : le dashboard rendu est inchangé', () => {
    const d = createEmptyDashboard('global', 'global', author);

    expect(d.type).toBe('global');
    expect(d.key).toBe('global');
    expect(d.intercom.messages).toEqual([]);
    expect(d.intercom.totalMessages).toBe(0);
    expect(d.lastModifiedBy).toEqual(author);
  });
});
