import { Tool } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getSharedStatePath, tryGetSharedStatePath, ensureStoreSubdir } from '../../utils/shared-state-path.js';
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
    let isAutoDetected = false;
    let resolvedPath = '';
    try {
        // Path resolution: explicit param > standard shared state path (#2307 Phase 4).
        // A relative param is anchored via path.resolve() so the caller always sees
        // the absolute path that was actually read — fs resolves relatives against
        // the server cwd anyway, silently, and the old code echoed the relative
        // string back as filePath (#2307).
        let roadmapPath = options.roadmapPath;
        if (!roadmapPath) {
            try {
                const sharedStatePath = getSharedStatePath();
                roadmapPath = path.join(sharedStatePath, 'sync-roadmap.md');
                isAutoDetected = true;
            } catch {
                // getSharedStatePath() threw — no shared path configured. This is
                // NOT "file not found": the file was never looked for. Distinct
                // error so a machine without RooSync shared state gets the real
                // cause instead of hunting a missing file (#2307).
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            code: 'NO_SHARED_STATE_PATH',
                            error: "Aucun chemin d'état partagé RooSync configuré (ROOSYNC_SHARED_PATH absente et aucun .env résolu). Indiquez roadmapPath explicitement."
                        }, null, 2)
                    }]
                };
            }
        }
        resolvedPath = path.resolve(roadmapPath);
        let stats;
        try {
            stats = await fs.stat(resolvedPath);
        } catch (error: any) {
            const isENOENT = error?.code === 'ENOENT' ||
                (typeof error?.message === 'string' && error.message.includes('ENOENT'));
            if (isENOENT) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            code: 'ROADMAP_NOT_FOUND',
                            error: `Fichier introuvable : ${resolvedPath}${isAutoDetected ? " (chemin auto-détecté depuis l'état partagé)" : ''}`
                        }, null, 2)
                    }]
                };
            }
            throw error;
        }
        const content = await fs.readFile(resolvedPath, 'utf8');

        const analysis: RoadmapAnalysis = {
            timestamp: new Date().toISOString(),
            filePath: resolvedPath,
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

        // Dialect honesty (#2307): the live sync-roadmap.md is written by
        // BaselineService as `## <emoji> Décision <id>` sections — this analyzer
        // only parses legacy DECISION_BLOCK markers. Measured on the po-2025
        // shared state: 142 KB roadmap, 311 decision sections, 0 DECISION_BLOCK
        // markers → totalDecisions: 0 reported as a clean success. Flag the
        // mismatch instead of implying the roadmap is empty.
        if (analysis.totalDecisions === 0) {
            const roadmapDialectSections = content.match(/## (?:⏳|✅|❌|🎯) Décision /g)?.length ?? 0;
            if (roadmapDialectSections > 0) {
                analysis.issues.push({
                    type: 'FORMAT_MISMATCH',
                    severity: 'HIGH',
                    count: roadmapDialectSections,
                    description: `Le roadmap contient ${roadmapDialectSections} sections '## <emoji> Décision' (dialecte BaselineService) mais 0 bloc DECISION_BLOCK analysable — totalDecisions=0 est un faux vert, pas une roadmap vide.`,
                    details: { parsedDialect: 'DECISION_BLOCK', presentDialect: 'emoji-sections' }
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
                await fs.writeFile(resolvedPath, updatedContent, 'utf8');
            }
        }

        let reportPath = null;
        if (options.generateReport) {
            // Logique de génération de rapport MD similaire au PS1
            // Simplifié pour cet outil MCP qui retourne principalement du JSON
            // Mais on peut écrire le fichier si demandé
            // #2307: with an explicit roadmapPath and no shared state configured,
            // getSharedStatePath() would throw and fail the whole call AFTER the
            // analysis succeeded — the report lands beside the analyzed file instead.
            const reportBase = tryGetSharedStatePath() ?? path.dirname(resolvedPath);
            const reportDir = path.join(reportBase, 'reports');
            ensureStoreSubdir(reportBase, 'reports');
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
        // readFile ENOENT race (deleted between stat and read) → friendly message
        // naming the exact path tried (#2307)
        const isENOENT = error?.code === 'ENOENT' ||
            (typeof error?.message === 'string' && error.message.includes('ENOENT'));
        if (isENOENT && resolvedPath) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: false,
                        code: 'ROADMAP_NOT_FOUND',
                        error: `Fichier introuvable : ${resolvedPath}`
                    }, null, 2)
                }]
            };
        }
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
