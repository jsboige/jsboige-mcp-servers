import { parseRoadmapMarkdown } from '../src/utils/roosync-parsers.js';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = join(tmpdir(), `roosync-debug-${Date.now()}`);
mkdirSync(testDir, { recursive: true });

const roadmapContent = `# Roadmap RooSync

## Décisions de Synchronisation

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-001\`
**Titre:** Mise à jour configuration test
**Statut:** pending
**Type:** config
**Chemin:** \`.config/test.json\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** MAC-DEV
**Créé:** 2025-10-08T09:00:00Z
**Détails:** Synchroniser paramètres de test
<!-- DECISION_BLOCK_END -->
`;

const filePath = join(testDir, 'sync-roadmap.md');
writeFileSync(filePath, roadmapContent, 'utf-8');

console.log('Fichier écrit à:', filePath);
console.log('Contenu:\n', roadmapContent);

try {
  const decisions = parseRoadmapMarkdown(filePath);
  console.log('Décisions parsées:', JSON.stringify(decisions, null, 2));

  if (decisions.length === 0) {
    console.error('AUCUNE DÉCISION TROUVÉE !');
  } else {
    console.log(`${decisions.length} décisions trouvées.`);
    if (decisions[0].id === 'test-decision-001') {
        console.log('ID correct.');
    } else {
        console.error(`ID incorrect: ${decisions[0].id}`);
    }
  }
} catch (error) {
  console.error('Erreur parsing:', error);
} finally {
  // rmSync(testDir, { recursive: true, force: true });
}