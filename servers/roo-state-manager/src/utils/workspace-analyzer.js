/**
 * Analyseur de workspace pour la détection automatique des workspaces
 * Phase 1 : Fondations et analyse de l'arborescence de tâches
 */
import * as path from 'path';
import { WorkspaceDetectionError } from '../types/task-tree.js';
export class WorkspaceAnalyzer {
    static TECH_INDICATORS = {
        'javascript': ['.js', '.jsx', '.ts', '.tsx', 'package.json', 'node_modules'],
        'python': ['.py', '.pyx', '.pyi', 'requirements.txt', 'setup.py', 'pyproject.toml', '__pycache__'],
        'java': ['.java', '.jar', '.class', 'pom.xml', 'build.gradle', 'src/main/java'],
        'csharp': ['.cs', '.csproj', '.sln', '.dll', 'bin/', 'obj/'],
        'cpp': ['.cpp', '.hpp', '.c', '.h', '.cc', '.cxx', 'CMakeLists.txt', 'Makefile'],
        'rust': ['.rs', 'Cargo.toml', 'Cargo.lock', 'src/main.rs'],
        'go': ['.go', 'go.mod', 'go.sum', 'main.go'],
        'php': ['.php', '.phar', 'composer.json', 'composer.lock'],
        'ruby': ['.rb', '.gem', 'Gemfile', 'Gemfile.lock'],
        'swift': ['.swift', '.xcodeproj', '.xcworkspace', 'Package.swift'],
        'kotlin': ['.kt', '.kts', 'build.gradle.kts'],
        'dart': ['.dart', 'pubspec.yaml', 'pubspec.lock'],
        'web': ['.html', '.css', '.scss', '.sass', '.less'],
        'config': ['.json', '.yaml', '.yml', '.toml', '.ini', '.conf'],
        'docker': ['Dockerfile', 'docker-compose.yml', '.dockerignore'],
        'git': ['.git/', '.gitignore', '.gitmodules'],
        'vscode': ['.vscode/', 'settings.json', 'launch.json', 'tasks.json'],
        'docs': ['.md', '.rst', '.txt', 'README', 'CHANGELOG', 'LICENSE']
    };
    static WORKSPACE_INDICATORS = [
        'package.json',
        'requirements.txt',
        'pom.xml',
        'build.gradle',
        'Cargo.toml',
        'go.mod',
        'composer.json',
        'Gemfile',
        'pubspec.yaml',
        '.git',
        '.vscode',
        'src/',
        'lib/',
        'test/',
        'tests/',
        'docs/',
        'README.md'
    ];
    static MIN_CONVERSATIONS_FOR_WORKSPACE = 3;
    static MIN_CONFIDENCE_THRESHOLD = 0.6;
    /**
     * Analyse les conversations pour détecter les workspaces
     */
    static async analyzeWorkspaces(conversations) {
        const startTime = Date.now();
        try {
            // 1. Extraction des patterns de fichiers
            const filePatterns = this.extractFilePatterns(conversations);
            // 2. Détection des préfixes communs
            const commonPrefixes = this.detectCommonPrefixes(conversations);
            // 3. Clustering par similarité de chemins
            const pathClusters = this.clusterBySimilarity(commonPrefixes);
            // 4. Génération des candidats workspace
            const workspaceCandidates = await this.generateWorkspaceCandidates(pathClusters, conversations, filePatterns);
            // 5. Validation et scoring des candidats
            const validatedWorkspaces = await this.validateWorkspaceCandidates(workspaceCandidates);
            // 6. Calcul des métriques de qualité
            const qualityMetrics = this.calculateQualityMetrics(validatedWorkspaces, conversations);
            const analysisTime = Date.now() - startTime;
            return {
                workspaces: validatedWorkspaces,
                totalConversations: conversations.length,
                analysisMetadata: {
                    version: '1.0.0',
                    analyzedAt: new Date().toISOString(),
                    analysisTime,
                    algorithmsUsed: ['path_clustering', 'tech_detection', 'confidence_scoring'],
                    qualityMetrics
                },
                relationships: [], // Sera rempli par le RelationshipAnalyzer
                errors: []
            };
        }
        catch (error) {
            throw new WorkspaceDetectionError(`Erreur lors de l'analyse des workspaces: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Extrait les patterns de fichiers des conversations
     */
    static extractFilePatterns(conversations) {
        const patternMap = new Map();
        for (const conversation of conversations) {
            if (conversation.metadata?.files_in_context) {
                for (const file of conversation.metadata.files_in_context) {
                    const ext = path.extname(file.path).toLowerCase();
                    const dir = path.dirname(file.path);
                    // Pattern par extension
                    if (ext) {
                        const current = patternMap.get(ext) || { count: 0, examples: [] };
                        current.count++;
                        if (current.examples.length < 5) {
                            current.examples.push(file.path);
                        }
                        patternMap.set(ext, current);
                    }
                    // Pattern par répertoire
                    const dirParts = dir.split(path.sep).filter(part => part && part !== '.');
                    for (const part of dirParts) {
                        const dirPattern = `${part}/`;
                        const current = patternMap.get(dirPattern) || { count: 0, examples: [] };
                        current.count++;
                        if (current.examples.length < 5) {
                            current.examples.push(file.path);
                        }
                        patternMap.set(dirPattern, current);
                    }
                }
            }
        }
        return Array.from(patternMap.entries())
            .map(([pattern, data]) => ({
            pattern,
            count: data.count,
            examples: data.examples,
            associatedTechnology: this.detectTechnologyFromPattern(pattern)
        }))
            .sort((a, b) => b.count - a.count);
    }
    /**
     * Détecte la technologie associée à un pattern
     */
    static detectTechnologyFromPattern(pattern) {
        for (const [tech, indicators] of Object.entries(this.TECH_INDICATORS)) {
            if (indicators.some(indicator => pattern.includes(indicator))) {
                return tech;
            }
        }
        return undefined;
    }
    /**
     * Détecte les préfixes communs dans les chemins de fichiers
     */
    static detectCommonPrefixes(conversations) {
        const pathMap = new Map();
        // Collecte tous les chemins
        for (const conversation of conversations) {
            if (conversation.metadata?.files_in_context) {
                for (const file of conversation.metadata.files_in_context) {
                    const normalizedPath = path.normalize(file.path);
                    const parts = normalizedPath.split(path.sep).filter(part => part && part !== '.');
                    // Génère tous les préfixes possibles
                    for (let i = 1; i <= parts.length; i++) {
                        const prefix = parts.slice(0, i).join(path.sep);
                        if (!pathMap.has(prefix)) {
                            pathMap.set(prefix, []);
                        }
                        pathMap.get(prefix).push(normalizedPath);
                    }
                }
            }
        }
        // Filtre et score les préfixes
        return Array.from(pathMap.entries())
            .map(([prefix, paths]) => ({
            prefix,
            count: paths.length,
            paths: [...new Set(paths)], // Supprime les doublons
            isWorkspaceCandidate: this.isWorkspaceCandidate(prefix, paths)
        }))
            .filter(item => item.count >= 2) // Au moins 2 fichiers
            .sort((a, b) => b.count - a.count);
    }
    /**
     * Détermine si un préfixe est un candidat workspace
     */
    static isWorkspaceCandidate(prefix, paths) {
        const prefixLower = prefix.toLowerCase();
        // Vérifie la présence d'indicateurs de workspace
        const hasWorkspaceIndicators = this.WORKSPACE_INDICATORS.some(indicator => paths.some(p => p.toLowerCase().includes(indicator.toLowerCase())));
        // Vérifie la structure (pas trop profond, pas trop superficiel)
        const depth = prefix.split(path.sep).length;
        const isGoodDepth = depth >= 1 && depth <= 4;
        // Évite les répertoires système
        const isSystemDir = ['node_modules', '.git', 'dist', 'build', 'target', '__pycache__']
            .some(dir => prefixLower.includes(dir));
        return hasWorkspaceIndicators && isGoodDepth && !isSystemDir;
    }
    /**
     * Clustering par similarité de chemins
     */
    static clusterBySimilarity(commonPrefixes) {
        const clusters = [];
        const used = new Set();
        for (const prefix of commonPrefixes) {
            if (used.has(prefix.prefix) || !prefix.isWorkspaceCandidate) {
                continue;
            }
            const cluster = {
                commonPrefix: prefix.prefix,
                paths: [...prefix.paths],
                depth: prefix.prefix.split(path.sep).length,
                confidence: this.calculatePrefixConfidence(prefix)
            };
            // Trouve les préfixes similaires
            for (const otherPrefix of commonPrefixes) {
                if (otherPrefix.prefix !== prefix.prefix &&
                    !used.has(otherPrefix.prefix) &&
                    this.areSimilarPrefixes(prefix.prefix, otherPrefix.prefix)) {
                    cluster.paths.push(...otherPrefix.paths);
                    used.add(otherPrefix.prefix);
                }
            }
            clusters.push(cluster);
            used.add(prefix.prefix);
        }
        return clusters.sort((a, b) => b.confidence - a.confidence);
    }
    /**
     * Calcule la confiance d'un préfixe
     */
    static calculatePrefixConfidence(prefix) {
        let confidence = 0;
        // Bonus pour le nombre de fichiers
        confidence += Math.min(prefix.count / 10, 0.3);
        // Bonus pour les indicateurs de workspace
        const workspaceIndicatorCount = this.WORKSPACE_INDICATORS
            .filter(indicator => prefix.paths.some(p => p.toLowerCase().includes(indicator.toLowerCase())))
            .length;
        confidence += workspaceIndicatorCount * 0.1;
        // Bonus pour la diversité des extensions
        const extensions = new Set(prefix.paths.map(p => path.extname(p).toLowerCase()).filter(ext => ext));
        confidence += Math.min(extensions.size / 5, 0.2);
        // Malus pour la profondeur excessive
        const depth = prefix.prefix.split(path.sep).length;
        if (depth > 3) {
            confidence -= (depth - 3) * 0.1;
        }
        return Math.max(0, Math.min(1, confidence));
    }
    /**
     * Vérifie si deux préfixes sont similaires
     */
    static areSimilarPrefixes(prefix1, prefix2) {
        const parts1 = prefix1.split(path.sep);
        const parts2 = prefix2.split(path.sep);
        // Même racine
        if (parts1[0] === parts2[0]) {
            return true;
        }
        // Préfixes imbriqués
        if (prefix1.startsWith(prefix2) || prefix2.startsWith(prefix1)) {
            return true;
        }
        return false;
    }
    /**
     * Génère les candidats workspace à partir des clusters
     */
    static async generateWorkspaceCandidates(pathClusters, conversations, filePatterns) {
        const candidates = [];
        for (const cluster of pathClusters) {
            // Trouve les conversations associées à ce cluster
            const associatedConversations = conversations.filter(conv => conv.metadata?.files_in_context?.some(file => cluster.paths.some(clusterPath => file.path.startsWith(cluster.commonPrefix))));
            if (associatedConversations.length < this.MIN_CONVERSATIONS_FOR_WORKSPACE) {
                continue;
            }
            // Détecte les technologies
            const detectedTechnologies = this.detectTechnologies(cluster.paths);
            // Génère le nom du workspace
            const workspaceName = this.generateWorkspaceName(cluster.commonPrefix);
            candidates.push({
                path: cluster.commonPrefix,
                name: workspaceName,
                confidence: cluster.confidence,
                conversations: associatedConversations,
                detectedTechnologies: detectedTechnologies.primary,
                filePatterns: filePatterns
                    .filter(pattern => cluster.paths.some(p => p.includes(pattern.pattern)))
                    .map(pattern => pattern.pattern),
                commonPrefixes: [cluster.commonPrefix]
            });
        }
        return candidates;
    }
    /**
     * Détecte les technologies utilisées dans un ensemble de chemins
     */
    static detectTechnologies(paths) {
        const evidence = [];
        const techScores = new Map();
        for (const [tech, indicators] of Object.entries(this.TECH_INDICATORS)) {
            let score = 0;
            for (const indicator of indicators) {
                const matchingPaths = paths.filter(p => p.toLowerCase().includes(indicator.toLowerCase()));
                if (matchingPaths.length > 0) {
                    const pathScore = matchingPaths.length / paths.length;
                    score += pathScore;
                    evidence.push({
                        type: indicator.startsWith('.') ? 'file_extension' :
                            indicator.includes('/') ? 'directory_structure' : 'config_file',
                        value: indicator,
                        confidence: pathScore
                    });
                }
            }
            if (score > 0) {
                techScores.set(tech, score);
            }
        }
        const sortedTechs = Array.from(techScores.entries())
            .sort((a, b) => b[1] - a[1]);
        const primary = sortedTechs.slice(0, 3).map(([tech]) => tech);
        const secondary = sortedTechs.slice(3, 6).map(([tech]) => tech);
        return {
            primary,
            secondary,
            confidence: sortedTechs.length > 0 ? sortedTechs[0][1] : 0,
            evidence
        };
    }
    /**
     * Génère un nom de workspace à partir du chemin
     */
    static generateWorkspaceName(workspacePath) {
        const parts = workspacePath.split(path.sep).filter(part => part);
        if (parts.length === 0) {
            return 'Root Workspace';
        }
        // Prend le dernier segment significatif
        const lastPart = parts[parts.length - 1];
        // Nettoie et formate le nom
        return lastPart
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, l => l.toUpperCase())
            .trim() || 'Unnamed Workspace';
    }
    /**
     * Valide et score les candidats workspace
     */
    static async validateWorkspaceCandidates(candidates) {
        const validatedCandidates = [];
        for (const candidate of candidates) {
            // Recalcule la confiance basée sur plusieurs facteurs
            let confidence = candidate.confidence;
            // Bonus pour le nombre de conversations
            confidence += Math.min(candidate.conversations.length / 10, 0.2);
            // Bonus pour la diversité technologique
            confidence += Math.min(candidate.detectedTechnologies.length / 5, 0.15);
            // Bonus pour les patterns de fichiers significatifs
            confidence += Math.min(candidate.filePatterns.length / 10, 0.15);
            // Normalise la confiance
            confidence = Math.max(0, Math.min(1, confidence));
            if (confidence >= this.MIN_CONFIDENCE_THRESHOLD) {
                validatedCandidates.push({
                    ...candidate,
                    confidence
                });
            }
        }
        return validatedCandidates.sort((a, b) => b.confidence - a.confidence);
    }
    /**
     * Calcule les métriques de qualité de l'analyse
     */
    static calculateQualityMetrics(workspaces, conversations) {
        const totalConversations = conversations.length;
        const classifiedConversations = workspaces.reduce((sum, ws) => sum + ws.conversations.length, 0);
        const workspaceDetectionAccuracy = totalConversations > 0 ?
            classifiedConversations / totalConversations : 0;
        const averageConfidence = workspaces.length > 0 ?
            workspaces.reduce((sum, ws) => sum + ws.confidence, 0) / workspaces.length : 0;
        return {
            workspaceDetectionAccuracy,
            projectClassificationAccuracy: 0, // Sera calculé par le ProjectClassifier
            clusterCoherence: 0, // Sera calculé par le TaskClusterer
            relationshipConfidence: averageConfidence
        };
    }
}
//# sourceMappingURL=workspace-analyzer.js.map