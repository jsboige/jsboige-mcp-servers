/**
 * Tests du garde à l'envoi #4206 — validateSendMessageRecipient (pur)
 *
 * Table couvrant CHAQUE exemple des familles A et D recensées dans l'issue
 * (refus avec message actionnable), plus la liste de passe explicite :
 * all, myia-po-2023, myia-po-2023:roo-extensions, famille B NanoClaw.
 *
 * Framework: Vitest
 * Issue: #4206
 *
 * @module utils/send-recipient-guard.test
 */

import { describe, it, expect } from 'vitest';
import { validateSendMessageRecipient } from '../dashboard-helpers.js';

// Roster et extra-liste EXPLICITES : le verdict ne doit dépendre d'aucun
// environnement (le défaut de la fonction lit env/config — ici on fige).
const ROSTER = ['zzz-legacy'];
const EXTRA = ['nanoclaw-cluster', 'nanoclaw:agent', 'nanoclaw:nanoclaw', 'cluster-manager:nanoclaw-cluster'];

function refuse(to: string) {
  return validateSendMessageRecipient(to, ROSTER, EXTRA);
}

describe('validateSendMessageRecipient (#4206, pur)', () => {
  describe('famille A — malformées côté émetteur : refus + suggestion', () => {
    it('machine répétée myia-ai-01:myia-ai-01:CoursIA-2 → suggestion dédupliquée', () => {
      const v = refuse('myia-ai-01:myia-ai-01:CoursIA-2');
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('machine répétée');
      expect(v.suggestion).toBe('myia-ai-01:CoursIA-2');
    });

    it('machine répétée myia-ai-01:myia-ai-01:qdrant → suggestion myia-ai-01:qdrant', () => {
      const v = refuse('myia-ai-01:myia-ai-01:qdrant');
      expect(v.ok).toBe(false);
      expect(v.suggestion).toBe('myia-ai-01:qdrant');
    });

    it('3 segments non répétés → trop de segments, suggestion tronquée à 2', () => {
      const v = refuse('myia-po-2023:roo-extensions:extra');
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('trop de segments');
      expect(v.suggestion).toBe('myia-po-2023:roo-extensions');
    });

    it('po-2023 nu → machine inconnue, suggestion myia-po-2023', () => {
      const v = refuse('po-2023');
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('machine "po-2023" inconnue');
      expect(v.suggestion).toBe('myia-po-2023');
    });

    it('préfixe perdu sur forme lane : po-2023:roo-extensions → suggestion myia-po-2023:roo-extensions', () => {
      const v = refuse('po-2023:roo-extensions');
      expect(v.ok).toBe(false);
      expect(v.suggestion).toBe('myia-po-2023:roo-extensions');
    });
  });

  describe('famille D — confusions de namespace : refus + suggestion', () => {
    it('global = clé de dashboard, pas un destinataire', () => {
      const v = refuse('global');
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('clé de dashboard');
      expect(v.suggestion).toBe('all | myia-po-2023 | myia-po-2023:roo-extensions');
    });

    it('machine = clé de dashboard', () => {
      const v = refuse('machine');
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('clé de dashboard');
    });

    it('workspace = clé de dashboard', () => {
      const v = refuse('workspace');
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('clé de dashboard');
    });

    it('po-204 (typo) → suggestion myia-po-204', () => {
      const v = refuse('po-204');
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('machine "po-204" inconnue');
      expect(v.suggestion).toBe('myia-po-204');
    });

    it('myia-po-2025:Microsoft VS Code → workspace auto-nommé (espace), suggestion machine seule', () => {
      const v = refuse('myia-po-2025:Microsoft VS Code');
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('workspace auto-nommé');
      expect(v.suggestion).toBe('myia-po-2025');
    });
  });

  describe('passes explicites (AC #4206)', () => {
    it('all (broadcast)', () => {
      expect(refuse('all').ok).toBe(true);
    });

    it('myia-po-2023 (machine seule)', () => {
      expect(refuse('myia-po-2023').ok).toBe(true);
    });

    it('myia-po-2023:roo-extensions (machine:workspace)', () => {
      expect(refuse('myia-po-2023:roo-extensions').ok).toBe(true);
    });

    it('famille B : cluster-manager:nanoclaw-cluster (entrée à deux-points, adresse complète)', () => {
      expect(refuse('cluster-manager:nanoclaw-cluster').ok).toBe(true);
    });

    it('famille B : nanoclaw-cluster:nanoclaw (lane d’une entrée nue)', () => {
      expect(refuse('nanoclaw-cluster:nanoclaw').ok).toBe(true);
    });

    it('famille B : nanoclaw-cluster et nanoclaw:agent nus', () => {
      expect(refuse('nanoclaw-cluster').ok).toBe(true);
      expect(refuse('nanoclaw:agent').ok).toBe(true);
    });

    it('machine hors forme myia-* mais dans le roster → passe (union #2591)', () => {
      expect(refuse('zzz-legacy').ok).toBe(true);
      expect(refuse('zzz-legacy:some-lane').ok).toBe(true);
    });
  });

  describe('bords', () => {
    it('destinataire vide / espaces seuls → refus', () => {
      expect(refuse('   ').ok).toBe(false);
      expect(refuse('').ok).toBe(false);
    });

    it('machine vide (:workspace) et workspace vide (machine:) → refus', () => {
      expect(refuse(':roo-extensions').ok).toBe(false);
      expect(refuse('myia-po-2023:').ok).toBe(false);
    });

    it('MYIA-PO-2023 (graphie) → refus fail-closed, cohérent avec FLEET_MACHINE_PATTERN', () => {
      const v = refuse('MYIA-PO-2023');
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('inconnue');
    });

    it('machine non corrigeable par préfixe (espace dans la tête) → suggestion = forme attendue', () => {
      const v = refuse('Microsoft VS Code');
      expect(v.ok).toBe(false);
      expect(v.suggestion).toBe('all | myia-po-2023 | myia-po-2023:roo-extensions');
    });

    it('whitespace autour d’un destinataire valide → passe (trim, pas de mutation)', () => {
      expect(refuse('  myia-po-2023  ').ok).toBe(true);
    });
  });
});
