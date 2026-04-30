/**
 * Détecteur de workspace pour le serveur MCP
 *
 * Problème: L'auto-detection actuelle utilise process.cwd() quand WORKSPACE_PATH
 * n'est pas défini, ce qui pointe vers le répertoire du serveur MCP au lieu
 * du workspace réel.
 *
 * Solution: Monter dans l'arborescence depuis __dirname pour trouver le workspace
 * réel en cherchant des marqueurs connus (.git, CLAUDE.md, etc.)
 */

import * as path from 'path';
import * as fs from 'fs/promises';

export interface WorkspaceDetectionResult {
    workspacePath: string;
    confidence: 'high' | 'medium' | 'low';
    method: 'WORKSPACE_PATH' | 'GIT' | 'CLAUDE_MD' | 'PACKAGE_JSON' | 'FALLBACK';
    markers: string[];
}

export class ServerWorkspaceDetector {
    private static readonly MARKERS = [
        '.git',
        '.claude/CLAUDE.md',
        'package.json',
        'README.md',
        '.vscode',
        'mcps',
        '.gitmodules'
    ];

    /**
     * Détecte le workspace réel depuis le serveur MCP
     */
    public static async detectWorkspace(): Promise<WorkspaceDetectionResult> {
        // 1. Vérifier d'abord WORKSPACE_PATH (si défini explicitement)
        if (process.env.WORKSPACE_PATH && process.env.WORKSPACE_PATH.trim()) {
            const exists = await this.pathExists(process.env.WORKSPACE_PATH);
            if (exists) {
                return {
                    workspacePath: process.env.WORKSPACE_PATH,
                    confidence: 'high',
                    method: 'WORKSPACE_PATH',
                    markers: []
                };
            }
        }

        // 2. Monter depuis __dirname pour trouver les marqueurs
        const serverDir = __dirname;
        const workspace = await this.findWorkspaceByMarkers(serverDir);

        if (workspace) {
            return workspace;
        }

        // 3. Dernier recours: remonter jusqu'au parent de mcps/
        const fallback = await this.fallbackDetection(serverDir);
        return fallback;
    }

    /**
     * Cherche le workspace en montant l'arborescence
     */
    private static async findWorkspaceByMarkers(startDir: string): Promise<WorkspaceDetectionResult | null> {
        let currentDir = startDir;
        const checkedPaths: string[] = [];

        // Limiter la montée pour éviter de sortir trop loin
        const maxDepth = 10;
        let depth = 0;

        while (depth <= maxDepth) {
            checkedPaths.push(currentDir);

            // Vérifier les marqueurs dans ce répertoire
            const markers = await this.findMarkersInDirectory(currentDir);

            if (markers.length > 0) {
                // Calculer le score de confiance
                const confidence = this.calculateConfidence(markers, currentDir);

                return {
                    workspacePath: currentDir,
                    confidence,
                    method: markers.includes('.git') ? 'GIT' :
                            markers.includes('.claude/CLAUDE.md') ? 'CLAUDE_MD' :
                            markers.includes('package.json') ? 'PACKAGE_JSON' : 'FALLBACK',
                    markers
                };
            }

            // Monter au répertoire parent
            const parentDir = path.dirname(currentDir);

            // Si on ne peut plus monter (racine du système), on s'arrête
            if (parentDir === currentDir) {
                break;
            }

            currentDir = parentDir;
            depth++;
        }

        return null;
    }

    /**
     * Détecte les marqueurs dans un répertoire
     */
    private static async findMarkersInDirectory(dir: string): Promise<string[]> {
        const foundMarkers: string[] = [];

        try {
            for (const marker of this.MARKERS) {
                const markerPath = path.join(dir, marker);
                const exists = await this.pathExists(markerPath);

                if (exists) {
                    foundMarkers.push(marker);
                }
            }
        } catch (error) {
            // Ignorer les erreurs d'accès
        }

        return foundMarkers;
    }

    /**
     * Calcule le score de confiance basé sur les marqueurs trouvés
     */
    private static calculateConfidence(markers: string[], dir: string): 'high' | 'medium' | 'low' {
        let score = 0;

        // Marqueurs forts
        if (markers.includes('.git')) score += 3;
        if (markers.includes('.claude/CLAUDE.md')) score += 3;
        if (markers.includes('package.json')) score += 2;

        // Marqueurs moyens
        if (markers.includes('README.md')) score += 1;
        if (markers.includes('.vscode')) score += 1;
        if (markers.includes('mcps')) score += 1;

        // Vérifier si c'est un répertoire roo-extensions
        if (dir.includes('roo-extensions') || dir.toLowerCase().includes('roo-extensions')) {
            score += 2;
        }

        if (score >= 5) return 'high';
        if (score >= 3) return 'medium';
        return 'low';
    }

    /**
     * Détecteur de fallback: remonter jusqu'au parent de mcps/
     */
    private static async fallbackDetection(serverDir: string): Promise<WorkspaceDetectionResult> {
        let currentDir = serverDir;

        // Remonter jusqu'à trouver un répertoire "mcps" parent
        while (currentDir !== path.dirname(currentDir)) {
            const parentDir = path.dirname(currentDir);
            const mcpsDir = path.join(parentDir, 'mcps');

            if (await this.pathExists(mcpsDir)) {
                // Le workspace est le parent du répertoire mcps
                return {
                    workspacePath: parentDir,
                    confidence: 'medium',
                    method: 'FALLBACK',
                    markers: ['mcps directory']
                };
            }

            currentDir = parentDir;
        }

        // Dernier recours: utiliser le parent direct du serveur
        return {
            workspacePath: path.dirname(serverDir),
            confidence: 'low',
            method: 'FALLBACK',
            markers: []
        };
    }

    /**
     * Vérifie si un chemin existe
     */
    private static async pathExists(path: string): Promise<boolean> {
        try {
            await fs.access(path);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Test unitaire rapide
     */
    public static async testDetection(): Promise<void> {
        console.log('\n=== TEST DE DÉTECTION WORKSPACE MCP ===');

        const result = await this.detectWorkspace();

        console.log(`Workspace détecté: ${result.workspacePath}`);
        console.log(`Confiance: ${result.confidence}`);
        console.log(`Méthode: ${result.method}`);
        console.log(`Marqueurs: ${result.markers.join(', ')}`);

        // Vérifier si le workspace est valide
        const isValid = await this.pathExists(result.workspacePath);
        console.log(`Chemin valide: ${isValid ? '✅' : '❌'}`);

        // Tester avec la logique actuelle pour comparaison
        const currentLogic = process.env.WORKSPACE_PATH || process.cwd();
        console.log(`\nComparaison avec la logique actuelle:`);
        console.log(`Logique actuelle: ${currentLogic}`);
        console.log(`Nouvelle détection: ${result.workspacePath}`);
        console.log(`Est-ce différent? ${currentLogic !== result.workspacePath ? '✅ (fixé)' : '❌ (même résultat)'}`);
    }
}