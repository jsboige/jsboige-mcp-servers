import { Tool } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { formatErrorForResponse } from '../../utils/error-format.js';

interface AnalyzeOptions {
    roadmapPath?: string;
    generateReport?: boolean;
    cleanupStale?: boolean;
}

interface AnalysisIssue {
    type: string;
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
    count: number;
    description: string;
    details?: any;
}

interface StaleDecision {
    decisionId: string;
    createdDate: string;
    ageDays: number;
}

interface RoadmapAnalysis {
    timestamp: string;
    filePath: string;
    fileSize: number;
    totalDecisions: number;
    pendingDecisions: number;
    approvedDecisions: number;
    staleDecisions: number;
    staleDecisionDetails: StaleDecision[];
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
            },
            cleanupStale: {
                type: 'boolean',
                description: 'Supprimer les décisions pending stale (>30j) du sync-roadmap.md (défaut: false)'
            }
        }
    },
};

export async function analyzeRooSyncProblems(options: AnalyzeOptions = {}) {
    try {
        // Path resolution: explicit param > standard shared state path (#2307 Phase 4)
        let roadmapPath = options.roadmapPath;
        if (!roadmapPath) {
            try {
                const sharedStatePath = getSharedStatePath();
                roadmapPath = path.join(sharedStatePath, 'sync-roadmap.md');
            } catch {
                // getSharedStatePath() threw — no shared path configured
            }
        }
        if (!roadmapPath) {
            return {
                content: [{
                        type: 'text',
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
            staleDecisions: 0,
            staleDecisionDetails: [],
            duplicateIds: [],
            corruptedHardware: [],
            statusInconsistencies: [],
            issues: [],
            success: true
        };
        const STALE_THRESHOLD_DAYS = 30;
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
                    // Stale detection: check if pending for > STALE_THRESHOLD_DAYS
                    const createdMatch = block.match(/\*\*Créé:\*\*\s*(\S+)/);
                    if (createdMatch) {
                        try {
                            const createdDate = new Date(createdMatch[1]);
                            const ageMs = Date.now() - createdDate.getTime();
                            const ageDays = ageMs / (1000 * 60 * 60 * 24);
                            if (ageDays > STALE_THRESHOLD_DAYS) {
                                analysis.staleDecisions++;
                                analysis.staleDecisionDetails.push({
                                    decisionId,
                                    createdDate: createdMatch[1],
                                    ageDays: Math.round(ageDays)
                                });
                            }
                        } catch {
                            // Invalid date format, skip stale check
                        }
                    }
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
        if (analysis.staleDecisions > 0) {
            analysis.issues.push({
                type: "STALE_PENDING_DECISIONS",
                severity: "MEDIUM",
                count: analysis.staleDecisions,
                description: `Décisions en attente depuis plus de ${STALE_THRESHOLD_DAYS} jours`,
                details: analysis.staleDecisionDetails
            });
        }

        // Cleanup stale pending decisions if requested
        let cleanedUp = 0;
        const cleanedDecisions: string[] = [];
        if (options.cleanupStale && analysis.staleDecisionDetails.length > 0) {
            const staleIds = new Set(analysis.staleDecisionDetails.map(d => d.decisionId));
            let updatedContent = content;
            // Match individual decision blocks (non-greedy within each block)
            const singleBlockRegex = /<!--[\s]*DECISION_BLOCK_START[\s]*-->([\s\S]*?)<!--[\s]*DECISION_BLOCK_END[\s]*-->\n?/g;
            let blockMatch;
            const blocksToRemove: string[] = [];
            while ((blockMatch = singleBlockRegex.exec(content)) !== null) {
                const fullBlock = blockMatch[0];
                const blockBody = blockMatch[1];
                const idInBlock = blockBody.match(/\*\*ID:\*\* `([^`]+)`/);
                if (idInBlock && staleIds.has(idInBlock[1])) {
                    blocksToRemove.push(fullBlock);
                }
            }
            for (const block of blocksToRemove) {
                const idx = updatedContent.indexOf(block);
                if (idx !== -1) {
                    updatedContent = updatedContent.substring(0, idx) + updatedContent.substring(idx + block.length);
                    cleanedUp++;
                    const idMatch = block.match(/\*\*ID:\*\* `([^`]+)`/);
                    if (idMatch) cleanedDecisions.push(idMatch[1]);
                }
            }
            if (cleanedUp > 0) {
                await fs.writeFile(roadmapPath!, updatedContent, 'utf8');
            }
        }

        let reportPath = null;
        if (options.generateReport) {
            // Logique de génération de rapport MD similaire au PS1
            // Simplifié pour cet outil MCP qui retourne principalement du JSON
            // Mais on peut écrire le fichier si demandé
            const reportDir = path.join(getSharedStatePath(), 'reports');
            await fs.mkdir(reportDir, { recursive: true });
            reportPath = path.join(reportDir, `PHASE3A-ANALYSE-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);

            const reportContent = `# Rapport d'Analyse RooSync
Date: ${analysis.timestamp}
Fichier: ${analysis.filePath}

## Résumé
- Total: ${analysis.totalDecisions}
- Pending: ${analysis.pendingDecisions}
	- Stale (>30j): ${analysis.staleDecisions}
	- Approved: ${analysis.approvedDecisions}
- Problèmes: ${analysis.issues.length}

## Détails Problèmes
${JSON.stringify(analysis.issues, null, 2)}
`;
            await fs.writeFile(reportPath, reportContent);

            // #2121: 7-day retention cap — purge old reports after each write
            const retentionMs = 7 * 24 * 60 * 60 * 1000;
            const cutoff = Date.now() - retentionMs;
            try {
                const existing = await fs.readdir(reportDir);
                let purged = 0;
                for (const f of existing) {
                    if (!f.startsWith('PHASE3A-ANALYSE-') || !f.endsWith('.md')) continue;
                    const match = f.match(/PHASE3A-ANALYSE-(\d{4})-(\d{2})-(\d{2})T/);
                    if (!match) continue;
                    const fileDate = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`).getTime();
                    if (fileDate < cutoff) {
                        await fs.unlink(path.join(reportDir, f));
                        purged++;
                    }
                }
                if (purged > 0) {
                    console.log(`#2121: Purged ${purged} reports older than 7 days`);
                }
            } catch (err) {
                // Non-critical — report cap failure doesn't affect analysis
            }
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    ...analysis,
                    reportGenerated: reportPath,
                    cleanupResult: options.cleanupStale ? {
                        cleanedUp,
                        cleanedDecisions,
                        message: cleanedUp > 0 ? `${cleanedUp} stale pending decisions removed from sync-roadmap.md` : 'No stale decisions to clean up'
                    } : undefined
                }, null, 2)
            }]
        };

    } catch (error: any) {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: false,
                    error: formatErrorForResponse(error)
                }, null, 2)
            }],
            isError: true
        };
    }
}
