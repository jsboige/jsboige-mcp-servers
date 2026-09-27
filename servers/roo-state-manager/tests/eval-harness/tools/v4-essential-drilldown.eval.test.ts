/**
 * v4-essential-drilldown.eval.test.ts — Golden drill-down eval for
 * conversation_browser view (#2609 V4: squelette essentiel + troncature qui
 * préserve le signal).
 *
 * Scenario golden #1 de l'Epic (baseline 16/06, live ai-01) : drill-down d'une
 * GRANDE conversation réelle sous budget serré (max_output_length: 12000,
 * detail summary) — les paramètres exacts de la mesure fondatrice où `view`
 * rendait 2,6 M chars (facteur ~217×) noyés sous des milliers de marqueurs
 * vides. Cette eval rejoue la classe de la mesure sur les données vivantes de
 * la machine.
 *
 * Rubrics évaluées sur données RÉELLES :
 * - (a) budget respecté : somme des blocs texte ≤ max_output_length ;
 * - (b) squelette essentiel : zéro marqueur `[role]:` vide dans le rendu ;
 *      comptabilité d'omission exacte (note ↔ messages vides du skeleton) ;
 * - (signal) le rendu porte du contenu substantiel, pas uniquement du bruit.
 *
 * La rubric (c) (coupes sur frontière de ligne) est prouvée déterministement
 * par les tests unitaires hardCapString (content-truncator.test.ts) — la
 * vérification live serait structurellement vacuous (le marqueur porte ses
 * propres \n\n).
 *
 * INCONCLUSIVE (pas FAIL) quand la machine n'a pas de grande conversation
 * locale — condition d'infra, pas un défaut de l'outil.
 *
 * @issue Epic #2609 V4
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { STORM_ACTIVE, STORM_GUARD_RESULT, runStormGuard } from '../storm-guard.js';
import type { ToolVerdict, CheckResult } from '../verdict.js';
import { viewConversationTree } from '../../../src/tools/view-conversation-tree.js';
import { loadSkeletonsFromDisk } from '../../../src/services/background-services.js';

// Module-level verdict accumulator (pattern des siblings V1/V3)
const verdicts: ToolVerdict[] = [];

/** Budget de la mesure fondatrice 16/06 : 12000 demandés. */
const GOLDEN_MAX_OUTPUT = 12_000;
/** Seuil de taille pour exercer la troncature : conversation substantielle. */
const MIN_MESSAGES = 100;

function textTotal(result: any): number {
    return (result?.content ?? [])
        .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
        .reduce((sum: number, c: any) => sum + c.text.length, 0);
}

function firstText(result: any): string {
    const first = result?.content?.[0];
    return first && first.type === 'text' ? first.text : '';
}

describe('conversation_browser view — golden drill-down eval (#2609 V4)', () => {
  beforeAll(async () => {
    await runStormGuard();
  });

  it('drill-down d\'une grande conversation réelle : budget tenu, zéro marqueur vide, omission comptée', async () => {
    if (STORM_ACTIVE) {
      console.log(`[INCONCLUSIVE] Storm guard active: ${STORM_GUARD_RESULT.reason}`);
      expect(STORM_GUARD_RESULT.active).toBe(true);
      return;
    }

    // ---- Charger le skeleton index RÉEL de la machine ----
    const cache = new Map<string, any>();
    await loadSkeletonsFromDisk(cache as any);

    if (cache.size === 0) {
      console.log('[INCONCLUSIVE] 0 conversations dans le skeleton index de cette machine.');
      return;
    }

    // ---- Cible evergreen : la plus grande conversation par messageCount ----
    let targetId: string | null = null;
    let targetCount = 0;
    for (const [id, skeleton] of cache.entries()) {
        const count = (skeleton as any)?.metadata?.messageCount ?? 0;
        if (count > targetCount) { targetCount = count; targetId = id; }
    }

    if (targetCount < MIN_MESSAGES) {
      console.log(
        `[INCONCLUSIVE] Plus grande conversation locale = ${targetCount} messages (< ${MIN_MESSAGES}). ` +
        'Pas assez de matière pour exercer la troncature sur cette machine.'
      );
      return;
    }

    const startMs = Date.now();
    const checks: CheckResult[] = [];
    let result: any;
    let callError: Error | undefined;

    try {
      result = await viewConversationTree.handler(
        {
          task_id: targetId,
          detail_level: 'summary',
          max_output_length: GOLDEN_MAX_OUTPUT,
          smart_truncation: true,
        },
        cache as any
      );
    } catch (err: any) {
      callError = err;
    }

    const latencyMs = Date.now() - startMs;
    const total = result ? textTotal(result) : 0;
    const text = result ? firstText(result) : '';

    // ---- Rubric (a) : budget respecté ----
    checks.push({
      name: `(a) budget: total rendu ≤ ${GOLDEN_MAX_OUTPUT}`,
      ok: callError === undefined && total > 0 && total <= GOLDEN_MAX_OUTPUT,
      observed: `${total} chars`,
    });

    // ---- Rubric (b) : zéro marqueur vide ----
    // En mode summary, un marqueur vit légitimement seul sur sa ligne
    // (`  [role]:\n    | contenu`) : le défaut V4 est le marqueur SUIVI DE RIEN
    // (ligne vide ou fin de sortie). Les marqueurs orphelins sont le critère.
    // (Les marqueurs vides inline du mode skeleton sont couverts par les tests
    // unitaires essential-skeleton.)
    const orphanMarkerCount =
      (text.match(/\[(?:👤 User|🤖 Assistant)\]:\n(?:[ \t]*\n|\s*$)/g) ?? []).length;
    checks.push({
      name: '(b) zéro marqueur [role] orphelin (suivi de rien) dans le rendu',
      ok: callError === undefined && orphanMarkerCount === 0,
      observed: orphanMarkerCount === 0 ? 'aucun' : `${orphanMarkerCount} orphelin(s)`,
    });

    // ---- Rubric (b-bis) : comptabilité d'omission exacte ----
    // Le handler hydrate le skeleton complet dans le cache (#584) : on peut
    // comparer le compte de messages vides réel à la note d'omission rendue.
    const hydrated = cache.get(targetId!);
    const sequence: any[] = (hydrated as any)?.sequence ?? [];
    const emptyInSource = sequence.filter(
      (item) => 'role' in item && !String((item as any).content ?? '').trim()
    ).length;
    const noteMatch = text.match(/\[\.\.\. (\d+) message\(s\) vide\(s\) omis\(s\) \.\.\.\]/);
    const noteCount = noteMatch ? parseInt(noteMatch[1], 10) : 0;
    const omissionOk = noteCount === emptyInSource && (emptyInSource > 0) === (noteMatch !== null);
    checks.push({
      name: '(b-bis) note d\'omission ↔ messages vides du skeleton',
      ok: callError === undefined && omissionOk,
      observed: `source=${emptyInSource}, note=${noteCount}`,
    });

    // ---- Rubric signal : le rendu porte du contenu substantiel ----
    const roleMarkers = (text.match(/\[(?:👤 User|🤖 Assistant)\]/g) ?? []).length;
    checks.push({
      name: 'signal: ≥ 3 messages substantiels rendus',
      ok: callError === undefined && roleMarkers >= 3,
      observed: `${roleMarkers} marqueurs de rôle`,
    });

    const allPass = checks.every((c) => c.ok);
    const verdict: 'PASS' | 'FAIL' = allPass ? 'PASS' : 'FAIL';
    verdicts.push({
      tool: 'conversation_browser(view)',
      query: { task_id: targetId, detail_level: 'summary', max_output_length: GOLDEN_MAX_OUTPUT, smart_truncation: true },
      verdict,
      reason: allPass
        ? `Drill-down ${targetCount} messages sous budget ${GOLDEN_MAX_OUTPUT}: toutes les rubrics V4 passent`
        : `Failed checks: ${checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`,
      latency_ms: latencyMs,
      checks,
      timestamp: new Date().toISOString(),
    });

    console.log(`[conversation_browser view #2609-V4] target=${targetId} (${targetCount} msgs) verdict=${verdict} latency=${latencyMs}ms`);
    for (const c of checks) {
      const mark = c.ok ? 'OK' : 'FAIL';
      console.log(`  [${mark}] ${c.name}${c.observed !== undefined ? ` → ${c.observed}` : ''}`);
    }

    // Vitest assertions (les checks INCONCLUSIVE ont déjà return au-dessus)
    expect(callError, 'Tool call should not throw').toBeUndefined();
    expect(total, '(a) budget respecté').toBeLessThanOrEqual(GOLDEN_MAX_OUTPUT);
    expect(orphanMarkerCount, '(b) aucun marqueur orphelin').toBe(0);
    expect(omissionOk, '(b-bis) comptabilité d\'omission').toBe(true);
    expect(roleMarkers, 'signal substantiel rendu').toBeGreaterThanOrEqual(3);
  }, 180_000);
});

export { verdicts };
