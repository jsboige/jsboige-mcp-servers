/**
 * #4037 (roo-extensions) — la sur-extraction newTask ne doit plus capturer
 * le <task> racine du parent ni les échos dupliqués de requête.
 *
 * Acceptance (issue #4037) sur le fixture réel bc93a6f7 :
 * - instructions extraites = 6 (les 6 spawns réels — mesuré avant fix : 10)
 * - préfixes dédupliqués = 6 (mesuré avant fix : 7)
 * - aucun préfixe enfant n'est égal à l'instruction principale du parent
 * - aucun mode n'est l'écho mal parsé « <mode> mode » (ex. « debug mode »)
 *
 * Le plancher est explicite : « === 6 » et non « pas de doublons », pour
 * qu'un résultat vide ne puisse jamais passer.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { messageExtractionCoordinator } from '../../src/utils/message-extraction-coordinator.js';
import { computeInstructionPrefix } from '../../src/utils/task-instruction-index.js';
import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'real-tasks', 'bc93a6f7-cd2e-4686-a832-46e3cd14d338');
const FIXTURE = join(FIXTURE_DIR, 'ui_messages.json');

describe('#4037 — extraction newTask sans sur-capture (fixture réel bc93a6f7)', () => {
  const raw = readFileSync(FIXTURE, 'utf-8');
  const messages = JSON.parse(raw);

  const result = messageExtractionCoordinator.extractFromMessages(messages, { maxLines: 0, onlyJsonFormat: false });
  const prefixes = [...new Set(result.instructions.map(i => computeInstructionPrefix(i.message, 192)).filter(p => p.length > 10))];

  it('extrait exactement les 6 spawns réels (plancher: égalité stricte, pas juste « pas de doublons »)', () => {
    // 6 appels newTask réels dans le fixture : messages ask/tool (msg 74, 84,
    // 96, 106, 135, 144). Avant #4037 : 10 brutes (racine parent + 3 échos).
    expect(result.instructions.length).toBe(6);
  });

  it('déduplique les préfixes à 6 (avant #4037 : 7)', () => {
    expect(prefixes.length).toBe(6);
  });

  it('aucun préfixe enfant ne vaut l\'instruction principale du parent', async () => {
    const mainInstruction = await RooStorageDetector.extractMainInstructionFromUI(FIXTURE, raw);
    expect(mainInstruction).toBeTruthy();
    const parentPrefix = computeInstructionPrefix(mainInstruction!, 192);
    // L'instruction racine du parent (« phase 1 : diagnostic système... »)
    // était capturée comme enfant avant #4037.
    expect(prefixes).not.toContain(parentPrefix);
  });

  it('aucun mode n\'est l\'écho mal parsé « <mode> mode »', () => {
    for (const inst of result.instructions) {
      expect(inst.mode).not.toMatch(/\smode$/i);
    }
  });
});
