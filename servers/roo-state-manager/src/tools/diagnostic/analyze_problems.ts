import { Tool } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

interface AnalyzeOptions {
    roadmapPath?: string;
    generateReport?: boolean;
}

interface AnalysisIssue {
    type: string;
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
    count: number;
    description: string;
    details?: any;
}

interface RoadmapAnalysis {
    timestamp: string;
    filePath: string;
    fileSize: number;
    totalDecisions: number;
    pendingDecisions: number;
    approvedDecisions: number;
    duplicateIds: string[];
    corruptedHardware: any[];
    statusInconsistencies: any[];
    issues: AnalysisIssue[];
    success: boolean;
    error?: string;
}

export const analyze_roosync_problems: Tool = {
    name: 'analyze_roosync_problems',
    description: 'Analyse le fichier sync-roadmap.md pour détecter les problèmes structurels et incohérences (doublons, statuts invalides, corruption).',
    inputSchema: {
        type: 'object',
        properties: {
            roadmapPath: {
                type: 'string',
                description: 'Chemin vers le fichier sync-roadmap.md (optionnel, défaut: autodetecté)'
            },
            generateReport: {
                type: 'boolean',
                description: 'Générer un rapport Markdown dans roo-config/reports (défaut: false)'
            }
        }
    },
};

export async function analyzeRooSyncProblems(options: AnalyzeOptions = {}) {
    try {
        // Détection du chemin
        let roadmapPath = options.roadmapPath;
        if (!roadmapPath) {
             // Tentative de détection standard
             // Note: En environnement MCP, les chemins relatifs peuvent varier.
             // On suppose une structure relative connue ou on cherche.
             // Pour l'instant on hardcode les chemins probables comme dans le script PS1 mais adaptés
             const commonPaths = [
                 '../../Drive/.shortcut-targets-by-id/1jEQqHabwXrIukTEI1vE05gWsJNYNNFVB/.shared-state/sync-roadmap.md', // Path du script PS1
                 'RooSync/sync-roadmap.md',
                 'docs/suivi/RooSync/sync-roadmap.md',
                 '.shared-state/sync-roadmap.md'
             ];
             
             for (const p of commonPaths) {
                 // Résolution du chemin absolu si nécessaire, ou relatif au CWD
                 const resolvedPath = path.resolve(process.cwd(), p);
                 try {
                     await fs.access(resolvedPath);
                     roadmapPath = resolvedPath;
                     break;
                 } catch {}
             }
        }

        if (!roadmapPath) {
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: false,
                        error: "Fichier sync-roadmap.md introuvable. Veuillez spécifier le chemin."
                    }, null, 2)
                }]
            };
        }

        const stats = await fs.stat(roadmapPath);
        const content = await fs.readFile(roadmapPath, 'utf8');

        const analysis: RoadmapAnalysis = {
            timestamp: new Date().toISOString(),
            filePath: roadmapPath,
            fileSize: stats.size,
            totalDecisions: 0,
            pendingDecisions: 0,
            approvedDecisions: 0,
            duplicateIds: [],
            corruptedHardware: [],
            statusInconsistencies: [],
            issues: [],
            success: true
        };

        // Regex pour extraire les blocs de décision
        // Adapté du PS1: (<!-- DECISION_BLOCK_START -->([\s\S]*?)<!-- DECISION_BLOCK_END -->)
        const blockRegex = /<!-- DECISION_BLOCK_START -->([\s\S]*?)<!-- DECISION_BLOCK_END -->/g;
        let match;
        const decisionIds: string[] = [];

        while ((match = blockRegex.exec(content)) !== null) {
            analysis.totalDecisions++;
            const block = match[1];

            // ID extraction
            const idMatch = block.match(/\*\*ID:\*\* `([^`]+)`/);
            let decisionId = "UNKNOWN";
            if (idMatch) {
                decisionId = idMatch[1];
                if (decisionIds.includes(decisionId)) {
                    analysis.duplicateIds.push(decisionId);
                }
                decisionIds.push(decisionId);
            }

            // Status extraction
            const statusMatch = block.match(/\*\*Statut:\*\* (\w+)/);
            if (statusMatch) {
                const status = statusMatch[1].toLowerCase();
                if (status === 'pending') {
                    analysis.pendingDecisions++;
                } else if (status === 'approved') {
                    analysis.approvedDecisions++;
                    if (!block.match(/\*\*Approuvé le:\*\*/)) {
                        analysis.statusInconsistencies.push({
                            type: "MISSING_APPROVAL_METADATA",
                            decisionId,
                            description: "Décision approved sans métadonnées d'approbation"
                        });
                    }
                }
            }

            // Hardware corruption detection
            if (block.includes('**Valeur Source:** 0')) {
                analysis.corruptedHardware.push({
                    type: "ZERO_VALUE",
                    decisionId,
                    description: "Valeur source à 0"
                });
            }
            if (block.includes('**Valeur Source:** "Unknown"')) {
                analysis.corruptedHardware.push({
                    type: "UNKNOWN_VALUE",
                    decisionId,
                    description: "Valeur source 'Unknown'"
                });
            }
        }

        // Consolidation des problèmes
        if (analysis.duplicateIds.length > 0) {
            analysis.issues.push({
                type: "DUPLICATE_DECISIONS",
                severity: "HIGH",
                count: analysis.duplicateIds.length,
                description: "Décisions en double détectées",
                details: analysis.duplicateIds
            });
        }
        if (analysis.corruptedHardware.length > 0) {
            analysis.issues.push({
                type: "CORRUPTED_HARDWARE_DATA",
                severity: "HIGH",
                count: analysis.corruptedHardware.length,
                description: "Données hardware corrompues",
                details: analysis.corruptedHardware
            });
        }
        if (analysis.statusInconsistencies.length > 0) {
            analysis.issues.push({
                type: "STATUS_INCONSISTENCIES",
                severity: "MEDIUM",
                count: analysis.statusInconsistencies.length,
                description: "Incohérences statut/métadonnées",
                details: analysis.statusInconsistencies
            });
        }

        let reportPath = null;
        if (options.generateReport) {
            // Logique de génération de rapport MD similaire au PS1
            // Simplifié pour cet outil MCP qui retourne principalement du JSON
            // Mais on peut écrire le fichier si demandé
            const reportDir = path.resolve(process.cwd(), 'roo-config/reports');
            await fs.mkdir(reportDir, { recursive: true });
            reportPath = path.join(reportDir, `PHASE3A-ANALYSE-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
            
            const reportContent = `# Rapport d'Analyse RooSync
Date: ${analysis.timestamp}
Fichier: ${analysis.filePath}

## Résumé
- Total: ${analysis.totalDecisions}
- Pending: ${analysis.pendingDecisions}
- Approved: ${analysis.approvedDecisions}
- Problèmes: ${analysis.issues.length}

## Détails Problèmes
${JSON.stringify(analysis.issues, null, 2)}
`;
            await fs.writeFile(reportPath, reportContent);
        }

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    ...analysis,
                    reportGenerated: reportPath
                }, null, 2)
            }]
        };

    } catch (error: any) {
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    success: false,
                    error: error.message,
                    stack: error.stack
                }, null, 2)
            }],
            isError: true
        };
    }
}