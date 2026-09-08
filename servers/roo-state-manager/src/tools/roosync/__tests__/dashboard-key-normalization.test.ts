/**
 * #3537 §6.3 — normalisation de la dérivation de clé (buildDashboardKey).
 *
 * Chaque classe de pollution du recensement des 61 clés (issue §4) doit être
 * redirigée vers la clé CANONIQUE à la dérivation — pas rejetée (la
 * réconciliation des clés EXISTANTES relève de l'action merge §6.2, et le rejet
 * à la création reste borné à la clé vide, PR #1133).
 *
 * Invariant de compatibilité : les entrées PROPRES dérivent à l'identique —
 * chaque règle est un no-op sur elles (trim, décodage, split ':', basename,
 * strip résiduel). C'est ce que verrouillent les tests "regression" ci-dessous,
 * y compris le mandat case-preserved du 2026-05-23.
 *
 * Contre-épreuve : sans les règles, les tests "pollution" rougissent (la clé
 * dérivée porte le résidu) tandis que les "regression" restent verts.
 */
// #858 / #864: garder le client LLM (condensation) inert au chargement du
// module — pattern dashboard-empty-key-guard.test.ts. Aucun appel n'arrive ici :
// buildDashboardKey est une fonction pure.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { vi, describe, it, expect } from 'vitest';
import { buildDashboardKey } from '../dashboard.js';

describe('buildDashboardKey — normalisation #3537 §6.3', () => {
  describe('pollution recensée → clé canonique', () => {
    it("URL-encodé '%3A' + adressage composé 'machine:workspace' → composante workspace", () => {
      // Mesuré : clé 'workspace-myia-po-2025%3ACoursIA-2' au rang de clé de plein droit.
      expect(buildDashboardKey('workspace', 'local', 'myia-po-2025%3ACoursIA-2'))
        .toBe('workspace-CoursIA-2');
      // Forme déjà décodée : même pliage (le ':' est aussi illégal en nom de
      // fichier NTFS — le garder produirait une clé matérialisable nulle part
      // sur la flotte Windows).
      expect(buildDashboardKey('workspace', 'local', 'myia-po-2025:CoursIA-2'))
        .toBe('workspace-CoursIA-2');
    });

    it("résidu '.md' / '.bak' / '.bak.<seg>' retiré du nom dérivé", () => {
      // Mesurés : 'workspace-CoursIA.md.bak', 'workspace-CoursIA-2.md.bak.c360'.
      expect(buildDashboardKey('workspace', 'local', 'CoursIA.md.bak')).toBe('workspace-CoursIA');
      expect(buildDashboardKey('workspace', 'local', 'CoursIA-2.md.bak.c360')).toBe('workspace-CoursIA-2');
      expect(buildDashboardKey('workspace', 'local', 'CoursIA.bak')).toBe('workspace-CoursIA');
      expect(buildDashboardKey('workspace', 'local', 'CoursIA.md')).toBe('workspace-CoursIA');
    });

    it("machineId : suffixe plateforme-arch retiré", () => {
      // Mesuré : 'myia-po-2025-win32-x64' comme machine_id d'une clé machine.
      expect(buildDashboardKey('machine', 'myia-po-2025-win32-x64', 'x')).toBe('machine-myia-po-2025');
      expect(buildDashboardKey('machine', 'myia-po-2025-linux-x64', 'x')).toBe('machine-myia-po-2025');
      expect(buildDashboardKey('machine', 'myia-po-2023-darwin-arm64', 'x')).toBe('machine-myia-po-2023');
    });

    it('whitespace trimmé (les clés "workspace- X" n’existent plus à la source)', () => {
      expect(buildDashboardKey('workspace', 'local', '  CoursIA  ')).toBe('workspace-CoursIA');
      expect(buildDashboardKey('machine', '  myia-po-2025  ', 'x')).toBe('machine-myia-po-2025');
    });
  });

  describe('regression — les entrées propres dérivent à l’identique', () => {
    it('noms nus case-preserved (mandat 2026-05-23)', () => {
      expect(buildDashboardKey('workspace', 'local', 'CoursIA')).toBe('workspace-CoursIA');
      expect(buildDashboardKey('workspace', 'local', 'Argumentum')).toBe('workspace-Argumentum');
      expect(buildDashboardKey('workspace', 'local', '2025-Epita-Intelligence-Symbolique'))
        .toBe('workspace-2025-Epita-Intelligence-Symbolique');
      expect(buildDashboardKey('workspace', 'local', 'LivresAgités')).toBe('workspace-LivresAgités');
    });

    it('chemins Windows/UNC collapsés au basename (comportement 2026-05-23 inchangé)', () => {
      expect(buildDashboardKey('workspace', 'local', 'C:\\dev\\CoursIA')).toBe('workspace-CoursIA');
      expect(buildDashboardKey('workspace', 'local', 'd:\\CoursIA')).toBe('workspace-CoursIA');
      expect(buildDashboardKey('workspace', 'local', 'g:\\Mon Drive\\MyIA\\CoursIA')).toBe('workspace-CoursIA');
      expect(buildDashboardKey('workspace', 'local', '/home/user/CoursIA')).toBe('workspace-CoursIA');
    });

    it('machineId propres et alias intentional inchangés', () => {
      expect(buildDashboardKey('machine', 'myia-po-2025', 'x')).toBe('machine-myia-po-2025');
      expect(buildDashboardKey('machine', 'myia-ai-01', 'x')).toBe('machine-myia-ai-01');
      // Alias intentional de l'outil (roosync_compare_config) — PAS réécrit.
      expect(buildDashboardKey('machine', 'local-machine', 'x')).toBe('machine-local-machine');
      // Le rewrite po-XXXX → myia-po-XXXX est délibérément absent (convention
      // flotte, pas une propriété du serveur — réconciliation via merge §6.2).
      expect(buildDashboardKey('machine', 'po-2023', 'x')).toBe('machine-po-2023');
    });

    it('guard anti double-préfixe préservé (#1409 item 2)', () => {
      expect(buildDashboardKey('workspace', 'local', 'workspace-Argumentum')).toBe('workspace-Argumentum');
      expect(buildDashboardKey('machine', 'machine-foo', 'x')).toBe('machine-foo');
    });

    it("global reste 'global' quels que soient les paramètres", () => {
      expect(buildDashboardKey('global', 'anything', 'anything')).toBe('global');
    });

    it(" '%' littéral invalide survit tel quel (le décodage n'avale pas un nom légitime)", () => {
      expect(buildDashboardKey('workspace', 'local', '100%_load')).toBe('workspace-100%_load');
      // Décodage restreint au résidu mesuré '%3A' : un '%20' littéral n'est PAS
      // muté en espace (revue #1134 — pas de classe de pollution derrière).
      expect(buildDashboardKey('workspace', 'local', '100%20load')).toBe('workspace-100%20load');
    });

    it('machineId : résidu .md/.bak retiré par symétrie avec la branche workspace', () => {
      expect(buildDashboardKey('machine', 'CoursIA.md.bak', 'x')).toBe('machine-CoursIA');
      expect(buildDashboardKey('machine', 'myia-po-2025.md', 'x')).toBe('machine-myia-po-2025');
    });

    it('clé vide inchangée à la dérivation — le refus reste création-seule (PR #1133)', () => {
      expect(buildDashboardKey('workspace', 'local', '')).toBe('workspace-');
      expect(buildDashboardKey('machine', '', 'x')).toBe('machine-');
    });
  });
});
