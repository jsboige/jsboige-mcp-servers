/**
 * Outil MCP : roosync_update_dashboard
 *
 * Met à jour la section de la machine courante dans le dashboard hiérarchique GDrive
 *
 * @module tools/roosync/update-dashboard
 * @version 1.0.0
 * @issue #546
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Schema de validation pour roosync_update_dashboard
 */
export const UpdateDashboardArgsSchema = z.object({
  section: z.enum(['machine', 'global', 'intercom', 'decisions', 'metrics'])
    .describe('Section du dashboard à mettre à jour'),
  content: z.string()
    .describe('Contenu markdown à insérer dans la section'),
  machine: z.string().optional()
    .describe('ID de la machine (requis si section=machine, défaut: ROOSYNC_MACHINE_ID)'),
  workspace: z.string().optional()
    .describe('Workspace (défaut: roo-extensions)'),
  mode: z.enum(['replace', 'append', 'prepend']).optional()
    .describe('Mode de mise à jour: replace (remplacer), append (ajouter à la fin), prepend (ajouter au début)')
});

export type UpdateDashboardArgs = z.infer<typeof UpdateDashboardArgsSchema>;

/**
 * Schema de retour pour roosync_update_dashboard
 */
export const UpdateDashboardResultSchema = z.object({
  success: z.boolean().describe('Indique si la mise à jour a réussi'),
  dashboardPath: z.string().describe('Chemin du dashboard mis à jour'),
  section: z.string().describe('Section mise à jour'),
  mode: z.string().describe('Mode de mise à jour utilisé'),
  timestamp: z.string().describe('Horodatage de la mise à jour')
});

export type UpdateDashboardResult = z.infer<typeof UpdateDashboardResultSchema>;

/**
 * Met à jour l'horodatage du dashboard
 */
async function updateDashboardTimestamp(dashboardPath: string, machineId: string, workspace: string): Promise<void> {
  const content = await fs.readFile(dashboardPath, 'utf8');
  const lines = content.split('\n');

  // Trouver et remplacer la ligne d'horodatage
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const newTimestamp = `**Dernière mise à jour:** ${now} par ${machineId}:${workspace}`;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Dernière mise à jour:')) {
      lines[i] = newTimestamp;
      break;
    }
  }

  await fs.writeFile(dashboardPath, lines.join('\n'), 'utf8');
}

/**
 * Met à jour la section "machine" d'une machine spécifique
 */
async function updateMachineSection(
  dashboardPath: string,
  machineId: string,
  workspace: string,
  content: string,
  mode: 'replace' | 'append' | 'prepend'
): Promise<void> {
  const dashboardContent = await fs.readFile(dashboardPath, 'utf8');
  const lines = dashboardContent.split('\n');

  // Trouver la section de la machine
  const machineHeaderIndex = lines.findIndex(line =>
    line.includes(`### ${machineId}`) ||
    line.match(new RegExp(`###\\s+${machineId.replace('-', '[- ]+')}`))
  );

  if (machineHeaderIndex === -1) {
    throw new Error(`Section pour machine ${machineId} non trouvée dans le dashboard. Utilisez roosync_init pour initialiser.`);
  }

  // Trouver la sous-section workspace
  const workspaceHeaderIndex = lines.findIndex((line, idx) =>
    idx > machineHeaderIndex &&
    line.includes(`#### ${workspace}`)
  );

  if (workspaceHeaderIndex === -1) {
    throw new Error(`Sous-section workspace ${workspace} non trouvée pour machine ${machineId}`);
  }

  // Trouver la fin de la section (prochain ### ou ##)
  let sectionEndIndex = lines.findIndex((line, idx) =>
    idx > workspaceHeaderIndex &&
    (line.startsWith('###') || line.startsWith('##'))
  );

  if (sectionEndIndex === -1) {
    sectionEndIndex = lines.length;
  }

  // Extraire le contenu existant (après la ligne "Notes libres:")
  let notesLineIndex = lines.findIndex((line, idx) =>
    idx >= workspaceHeaderIndex &&
    idx < sectionEndIndex &&
    line.includes('Notes libres')
  );

  if (notesLineIndex === -1) {
    throw new Error(`Sous-section "Notes libres" non trouvée pour ${machineId}:${workspace}`);
  }

  // Construire le nouveau contenu
  const beforeNotes = lines.slice(0, notesLineIndex + 1);
  const afterNotes = lines.slice(sectionEndIndex);

  let newContent;
  if (mode === 'replace') {
    newContent = content.trim();
  } else if (mode === 'append') {
    const existingNotes = lines.slice(notesLineIndex + 2, sectionEndIndex).join('\n').trim();
    newContent = existingNotes + '\n' + content.trim();
  } else { // prepend
    const existingNotes = lines.slice(notesLineIndex + 2, sectionEndIndex).join('\n').trim();
    newContent = content.trim() + '\n' + existingNotes;
  }

  // Réassembler avec indentation correcte
  const newLines = [
    ...beforeNotes,
    '',
    newContent.split('\n').map(line => `  ${line}`).join('\n'),
    '',
    ...afterNotes
  ].flat();

  await fs.writeFile(dashboardPath, newLines.join('\n'), 'utf8');
}

/**
 * Met à jour les autres sections (global, intercom, decisions, metrics)
 */
async function updateGenericSection(
  dashboardPath: string,
  section: string,
  content: string,
  mode: 'replace' | 'append' | 'prepend'
): Promise<void> {
  const dashboardContent = await fs.readFile(dashboardPath, 'utf8');
  const lines = dashboardContent.split('\n');

  // Mapper les sections aux titres markdown
  const sectionTitles: Record<string, string> = {
    'global': 'État Global',
    'intercom': 'Notes Inter-Agents',
    'decisions': 'Décisions en Attente',
    'metrics': 'Métriques'
  };

  const sectionTitle = sectionTitles[section];
  const sectionHeaderIndex = lines.findIndex(line => line.includes(`## ${sectionTitle}`));

  if (sectionHeaderIndex === -1) {
    throw new Error(`Section "${section}" (${sectionTitle}) non trouvée dans le dashboard`);
  }

  // Trouver la fin de la section
  let sectionEndIndex = lines.findIndex((line, idx) =>
    idx > sectionHeaderIndex &&
    line.startsWith('##')
  );

  if (sectionEndIndex === -1) {
    sectionEndIndex = lines.length;
  }

  // Construire le nouveau contenu
  const beforeSection = lines.slice(0, sectionHeaderIndex + 1);
  const sectionContent = lines.slice(sectionHeaderIndex + 1, sectionEndIndex).join('\n');
  const afterSection = lines.slice(sectionEndIndex);

  let newContent;
  if (mode === 'replace') {
    newContent = content.trim();
  } else if (mode === 'append') {
    newContent = sectionContent.trim() + '\n' + content.trim();
  } else { // prepend
    newContent = content.trim() + '\n' + sectionContent.trim();
  }

  const newLines = [
    ...beforeSection,
    '',
    newContent,
    '',
    ...afterSection
  ];

  await fs.writeFile(dashboardPath, newLines.join('\n'), 'utf8');
}

/**
 * Outil roosync_update_dashboard
 *
 * Met à jour la section spécifiée dans le dashboard hiérarchique GDrive
 *
 * @param args Arguments validés
 * @returns Résultat de la mise à jour
 */
export async function roosyncUpdateDashboard(args: UpdateDashboardArgs): Promise<UpdateDashboardResult> {
  try {
    const sharedPath = process.env.ROOSYNC_SHARED_PATH;
    if (!sharedPath) {
      throw new Error('ROOSYNC_SHARED_PATH non configuré dans .env');
    }

    const dashboardPath = path.join(sharedPath, 'DASHBOARD.md');

    // Vérifier que le dashboard existe
    try {
      await fs.access(dashboardPath);
    } catch {
      throw new Error(`Dashboard non trouvé à ${dashboardPath}. Utilisez roosync_init pour initialiser.`);
    }

    const machineId = args.machine || process.env.ROOSYNC_MACHINE_ID;
    if (!machineId) {
      throw new Error('Impossible de déterminer ROOSYNC_MACHINE_ID');
    }

    const workspace = args.workspace || 'roo-extensions';
    const mode = args.mode || 'replace';

    console.log(`[UPDATE DASHBOARD] Section: ${args.section}, Mode: ${mode}`);

    // Mettre à jour la section spécifiée
    if (args.section === 'machine') {
      await updateMachineSection(dashboardPath, machineId, workspace, args.content, mode);
    } else {
      await updateGenericSection(dashboardPath, args.section, args.content, mode);
    }

    // Mettre à jour l'horodatage
    await updateDashboardTimestamp(dashboardPath, machineId, workspace);

    const timestamp = new Date().toISOString();

    console.log('[UPDATE DASHBOARD] Dashboard mis à jour avec succès:', dashboardPath);

    return {
      success: true,
      dashboardPath,
      section: args.section,
      mode,
      timestamp
    };
  } catch (error) {
    console.error('[UPDATE DASHBOARD] Erreur:', error);
    throw new Error(`Erreur lors de la mise à jour du dashboard: ${(error as Error).message}`);
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const updateDashboardToolMetadata = {
  name: 'roosync_update_dashboard',
  description: 'Met à jour une section du dashboard hiérarchique RooSync sur GDrive (#546)',
  inputSchema: {
    type: 'object' as const,
    properties: {
      section: {
        type: 'string',
        enum: ['machine', 'global', 'intercom', 'decisions', 'metrics'],
        description: 'Section du dashboard à mettre à jour'
      },
      content: {
        type: 'string',
        description: 'Contenu markdown à insérer dans la section'
      },
      machine: {
        type: 'string',
        description: 'ID de la machine (requis si section=machine, défaut: ROOSYNC_MACHINE_ID)'
      },
      workspace: {
        type: 'string',
        description: 'Workspace (défaut: roo-extensions)'
      },
      mode: {
        type: 'string',
        enum: ['replace', 'append', 'prepend'],
        description: 'Mode de mise à jour: replace (remplacer), append (ajouter à la fin), prepend (ajouter au début)'
      }
    },
    required: ['section', 'content'],
    additionalProperties: false
  }
};
