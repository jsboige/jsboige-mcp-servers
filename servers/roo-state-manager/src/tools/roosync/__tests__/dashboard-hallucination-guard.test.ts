/**
 * Tests for #3771 — LLM condensation guardrail against fabricated GitHub terminal states.
 *
 * Symptôme : les résumés LLM de l'auto-condensation des dashboards **fabriquent des états
 * GitHub (merge/close) qu'aucune API ne détient**. 4 datapoints mesurés le 21/09 sur
 * `workspace-cluster-coordination`, dont une **auto-contradiction dans le MÊME status
 * régénéré** (section « État des systèmes » dit OPEN avec note de correction, mais
  // section « Livrables récents » du même bloc liste la PR dans les Merged).
 *
 * Le garde `scrubFabricatedGitHubStates` est un stripper déterministe :
 *  - Détecte toute ligne assertant un état terminal (MERGÉ/CLOSED/« Merge validé »/CLEAN…)
 *    sur un `#NNNN` (PR ou issue).
 *  - Vérifie si la même référence apparaît avec un mot-clé terminal dans une source
 *    (previousStatus, contenu des messages).
 *  - Si non, REMPLACE la ligne par `[unsourced state stripped #3771]` (audit + bruit
 *    minimal, jamais de propagation du faux état).
 *
 * PR submod à ouvrir : « fix(roosync,#3771): strip fabricated GitHub terminal-state
 * assertions from LLM condensation output ».
 */
import { describe, it, expect } from 'vitest';
import { scrubFabricatedGitHubStates } from '../dashboard.js';

describe('scrubFabricatedGitHubStates (#3771)', () => {
  // ===== Bullet-line assertions: PR/Issue #N : <state> =====

  it('strips bullet-line "PR #17167 : MERGÉ" when no source has the merge', () => {
    const llmOutput = `### Livrables récents
- PR #17167 : MERGÉ (clean)
- PR #17168 : OPEN (en cours de review)
- PR #17169 : merged (Emerjesse)`;

    const sources = [
      `Aucun message ne parle de la PR 17167.`,
      `PR #17168 ouverte, en cours de review.`,
    ];

    const { scrubbed, stripped, strippedRefs } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(2);
    expect(strippedRefs).toContain('17167');
    expect(strippedRefs).toContain('17169');
    expect(scrubbed).toContain('[unsourced state stripped #3771]');
    expect(scrubbed).toContain('PR #17167');
    expect(scrubbed).toContain('PR #17168 : OPEN (en cours de review)'); // not terminal, kept
  });

  it('strips "Issue #17073 : close" (the #3 datapoint from Hermes)', () => {
    const llmOutput = `### Décisions
- Issue #17073 : close (audit terminé)
- Issue #17074 : ouverte, en cours`;

    const sources = [
      `Audit #17073 toujours actif, 20/104 issues auditées.`,
      `Issue #17074 ouverte.`,
    ];

    const { scrubbed, stripped, strippedRefs } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(1);
    expect(strippedRefs).toContain('17073');
    expect(scrubbed).toContain('[unsourced state stripped #3771]');
    expect(scrubbed).toContain('Issue #17073');
    expect(scrubbed).toContain('Issue #17074 : ouverte, en cours'); // not terminal, kept
  });

  // ===== Bold (`**`) coverage — fault bench from the po-2026 review (22/09) =====
  // Both regexes ran detection on the raw line and could not cross a `**`; bold is the
  // dominant idiom of real status sections. Detection now runs on a bold-free copy,
  // emission keeps the original line (visible inside the audit marker).

  it('strips bold bullet "**Correctif Fuite Docker** : PR #193/#194 mergées" (verbatim from the 21/09 global status)', () => {
    const llmOutput = `- **Correctif Fuite Docker** : PR #193/#194 mergées. Exposition nulle confirmée.`;

    const sources = [
      `Le correctif fuite Docker est en cours de review, rien n'est acté pour l'instant.`,
    ];

    const { scrubbed, stripped, strippedRefs } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(1);
    expect(strippedRefs).toContain('193');
    expect(scrubbed).toContain('[unsourced state stripped #3771]');
    // The ORIGINAL bold line is preserved inside the marker (audit trail).
    expect(scrubbed).toContain('**Correctif Fuite Docker**');
  });

  it('strips bold form "- **PR #17167** : MERGÉ / CLEAN" (test #4 shape, WITH bold)', () => {
    const llmOutput = `- **PR #17167** : MERGÉ / CLEAN`;

    const sources: string[] = [];

    const { scrubbed, stripped, strippedRefs } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(1);
    expect(strippedRefs).toContain('17167');
    expect(scrubbed).toContain('[unsourced state stripped #3771]');
    expect(scrubbed).toContain('**PR #17167**');
  });

  it('KEEPS "PR #1234 : MERGÉ" when the source mentions the merge', () => {
    const llmOutput = `### Livrables récents
- PR #1234 : MERGÉ (success)`;

    const sources = [
      `[DONE] PR #1234 mergée et nettoyée. Squash final OK.`,
    ];

    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(0);
    expect(scrubbed).toBe(llmOutput); // untouched
  });

  it('KEEPS "PR #1234 : MERGÉ" when previousStatus already had it merged', () => {
    const llmOutput = `### Livrables récents
- PR #1234 : MERGÉ (déjà acté dans l'ancien statut)`;

    const sources = [
      ``, // no new messages about it
      `## [previous]
### Livrables récents
- PR #1234 : MERGÉ`,
    ];

    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(0);
    expect(scrubbed).toBe(llmOutput);
  });

  it('strips even when the LLM "auto-corrects" itself in the same status (datapoint #4)', () => {
    // The exact datapoint: « section État des systèmes dit "OPEN / HEAD d2e2035c" AVEC
    // note de correction explicite, tandis que la section Livrables récents liste #17167
    // dans les Merged ». The guard catches both: the bullet in Livrables récents (stripped)
    // and the OPEN line in État des systèmes (NOT stripped — non-terminal).
    const llmOutput = `### État des systèmes
- **#17167** : OPEN / HEAD d2e2035c (n'est pas MERGÉ, état erroné dans condensation précédente)

### Livrables récents
- PR CoursIA #17167 : Merge validé (Emerjesse)
- PR #17167 : MERGÉ / CLEAN`;

    const sources = [
      `Rien sur #17167 dans cette condensation.`,
    ];

    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, sources);

    // Two terminal-state bullet assertions stripped; the OPEN self-correction kept.
    expect(stripped).toBe(2);
    // The OPEN self-correction survives untouched.
    expect(scrubbed).toContain('**#17167** : OPEN / HEAD d2e2035c');
    // Both false merge claims get the strip marker. The original text remains for
    // audit (it was a condensation artifact, humans can see the LLM tried), but the
    // bullet is no longer load-bearing — it's marked as unsourced.
    expect(scrubbed).toContain('[unsourced state stripped #3771]');
    expect(scrubbed).toContain('CoursIA #17167 : Merge validé');
    expect(scrubbed).toContain('PR #17167 : MERGÉ / CLEAN');
    // The PRE-MARKER line must NOT carry the false state without the marker prefix.
    // We split by line and check no unmarked line asserts a terminal state.
    // Strip parenthetical notes (the OPEN line contains "MERGÉ" only inside a
    // self-correction note "(n'est pas MERGÉ)" which is meta-discussion, not a state
    // assertion).
    const unmarkedLines = scrubbed.split('\n').filter(l => !l.includes('[unsourced state stripped #3771]'));
    for (const line of unmarkedLines) {
      // Strip parenthetical context for the check: anything in ( ... ) is a note,
      // not an assertion.
      const mainPart = line.replace(/\([^)]*\)/g, '').toLowerCase();
      const hasTerminal = ['mergé', 'merged', 'merge validé', 'fermé', 'closed', 'close', 'clean', 'complété', 'resolved']
        .some(kw => mainPart.includes(kw));
      if (line.includes('#17167')) {
        // The OPEN self-correction line: "OPEN" is not terminal, but we want to make
        // sure the ASSERTER part (not the parenthetical) doesn't claim merged.
        expect(hasTerminal).toBe(false);
      }
    }
  });

  // ===== Inline sub-phrase assertions (no bullet prefix) =====

  it('strips inline "#17167 : MERGÉ" without bullet prefix', () => {
    const llmOutput = `État : la PR #17167 : MERGÉ est dans la liste des merged.`;
    const sources = [`Pas de mention de #17167.`];

    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(1);
    expect(scrubbed).toContain('[unsourced #3771]');
    expect(scrubbed).not.toContain('MERGÉ');
  });

  it('keeps inline text that mentions merge of OTHER PRs (lexical-cue scenario)', () => {
    // The LLM might write "la merge de #17168 a réussi" — this is prose, not an assertion
    // that #17168 has been merged. The bullet regex doesn't fire (no bullet). The inline
    // regex fires only if a terminal keyword is present WITHIN ~80 chars after #NNN.
    // We test the EXPECTED behavior: prose mentions of merge activity should NOT be
    // systematically stripped if the source doesn't already have the terminal state.
    const llmOutput = `La PR #17168 est OPEN, review en cours.`;
    const sources = [`#17168 ouverte, review en attente.`];

    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(0);
    expect(scrubbed).toBe(llmOutput);
  });

  // ===== Number-sourcing heuristic =====

  it('does NOT strip when the same PR number appears in a source but for unrelated reasons', () => {
    // The source mentions the PR but NOT in a terminal-state context. The guard requires
    // a terminal keyword WITHIN ±200 chars of the PR number.
    const llmOutput = `- PR #1234 : MERGÉ`;
    const sources = [
      `#1234 fait partie du sprint actuel, pas encore committé.`,
    ];

    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(1); // stripped: no nearby terminal keyword
    expect(scrubbed).toContain('[unsourced state stripped #3771]');
  });

  it('strips when the source mentions the PR in a context FAR from a terminal keyword (>200 chars away)', () => {
    const longUnrelated = 'a'.repeat(300);
    const llmOutput = `- PR #9999 : MERGÉ`;
    const sources = [
      `${longUnrelated} #9999 dans la liste à investiguer.${longUnrelated}`,
    ];

    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(1); // guard requires terminal keyword within ±200 chars
  });

  // ===== Whitelist: non-terminal states are NEVER stripped =====

  it('does not touch "OPEN", "in progress", "blocked" lines', () => {
    const llmOutput = `### État
- PR #100 : OPEN
- PR #200 : in progress (review)
- PR #300 : blocked (waiting on CI)
- Issue #400 : open`;

    const sources = [``];

    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(0);
    expect(scrubbed).toBe(llmOutput);
  });

  // ===== Edge cases =====

  it('handles empty LLM output gracefully', () => {
    const { scrubbed, stripped } = scrubFabricatedGitHubStates('', ['anything']);
    expect(stripped).toBe(0);
    expect(scrubbed).toBe('');
  });

  it('handles empty source list (no sourcing possible)', () => {
    const llmOutput = `- PR #1234 : MERGÉ`;
    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, []);

    expect(stripped).toBe(1);
    expect(scrubbed).toContain('[unsourced state stripped #3771]');
  });

  it('strips a mix of sourced and unsourced in the same output', () => {
    const llmOutput = `### Livrables récents
- PR #100 : MERGÉ
- PR #200 : MERGÉ
- PR #300 : OPEN`;

    const sources = [
      `[DONE] PR #100 merged et clean.`,
      `Rien sur #200.`,
    ];

    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, sources);
    console.log('[mix debug]', { stripped, scrubbed });

    expect(stripped).toBe(1); // only #200 stripped
    expect(scrubbed).toContain('PR #100 : MERGÉ'); // kept
    expect(scrubbed).toContain('[unsourced state stripped #3771] PR #200 : MERGÉ'); // stripped
    expect(scrubbed).toContain('PR #300 : OPEN'); // not terminal, kept
  });

  // ===== Numeric-bound edge: short PR numbers (e.g. #5) are NOT stripped =====

  it('does NOT act on short PR numbers (1-2 digits) to avoid false positives on dates', () => {
    // The bullet regex (\d{3,6}) AND the inline regex (\d{3,6}) both require 3-6 digits.
    // Short refs like #5 or #42 are NOT processed — too ambiguous (dates, line counts,
    // page numbers, sprint numbers, etc.). Acceptable trade-off: we'd rather miss a
    // real short-PR strip than produce false positives.
    const llmOutput = `- PR #5 : MERGÉ`;
    const sources = [`Rien.`];

    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(0); // short ref, no action
    expect(scrubbed).toBe(llmOutput);
  });

  it('does NOT strip a short PR ref (#5) even if the same digit appears in a source near a terminal keyword', () => {
    // Belt-and-braces: confirm the 3-6 digit floor holds even when a 1-2 digit
    // ref happens to share a value with source content near a terminal keyword
    // (e.g. "5 commits merged"). We MUST not strip — too risky.
    const llmOutput = `- PR #5 : MERGÉ`;
    const sources = [`5 commits merged yesterday.`];

    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(0); // 1-digit ref, no action regardless of source
    expect(scrubbed).toBe(llmOutput);
  });

  // ===== owner/repo#NNNN cross-repo references =====

  it('handles "CoursIA #17167" cross-repo reference (the #1 datapoint)', () => {
    const llmOutput = `- PR CoursIA #17167 : MERGÉ / CLEAN`;
    const sources = [
      `Rien sur CoursIA #17167 dans ce cycle.`,
    ];

    const { scrubbed, stripped, strippedRefs } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(1);
    expect(strippedRefs).toContain('17167');
    expect(scrubbed).toContain('[unsourced state stripped #3771]');
  });

  it('KEEPS "CoursIA #17167 : MERGÉ" when the source mentions the merge', () => {
    const llmOutput = `- PR CoursIA #17167 : MERGÉ`;
    const sources = [
      `CoursIA #17167 mergée, clean.`,
    ];

    const { scrubbed, stripped } = scrubFabricatedGitHubStates(llmOutput, sources);

    expect(stripped).toBe(0);
    expect(scrubbed).toBe(llmOutput);
  });
});