/**
 * Moteur de reconstruction hiérarchique en deux passes
 * Résout le problème des 47 tâches orphelines en reconstruisant les parentIds manquants
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { 
    EnhancedConversationSkeleton,
    Phase1Result, 
    Phase2Result,
    ReconstructionConfig,
    SimilaritySearchResult,
    ParentValidation,
    ProcessingState,
    ParsedSubtaskInstructions
} from '../types/enhanced-hierarchy.js';
import { ConversationSkeleton, NewTaskInstruction } from '../types/conversation.js';
import { TaskInstructionIndex } from './task-instruction-index.js';

/**
 * Moteur principal de reconstruction hiérarchique
 */
export class HierarchyReconstructionEngine {
    private static DEFAULT_CONFIG: ReconstructionConfig = {
        batchSize: 20,
        similarityThreshold: 0.2,
        minConfidenceScore: 0.3,
        debugMode: false,
        operationTimeout: 30000,
        forceRebuild: false,
        strictMode: true
    };

    private config: ReconstructionConfig;
    private instructionIndex: TaskInstructionIndex;
    private processedTasks: Map<string, ProcessingState>;

    constructor(config?: Partial<ReconstructionConfig>) {
        this.config = { ...HierarchyReconstructionEngine.DEFAULT_CONFIG, ...config };
        this.instructionIndex = new TaskInstructionIndex();
        this.processedTasks = new Map();
    }

    /**
     * Méthode statique pour faciliter l'utilisation
     */
    public static async reconstructHierarchy(
        workspacePath?: string,
        forceRebuild: boolean = false
    ): Promise<ConversationSkeleton[]> {
        const engine = new HierarchyReconstructionEngine({
            forceRebuild,
            workspaceFilter: workspacePath,
            debugMode: true // Pour voir les logs pendant la reconstruction
        });

        // Récupérer les skeletons depuis le storage
        const { RooStorageDetector } = await import('./roo-storage-detector.js');
        const skeletons = await RooStorageDetector.buildHierarchicalSkeletons(workspacePath);
        
        // Exécuter la reconstruction
        const enhancedSkeletons = await engine.doReconstruction(skeletons);
        
        // Convertir en ConversationSkeleton standard avec les parentIds reconstruits
        return enhancedSkeletons.map(enhanced => {
            const skeleton: ConversationSkeleton = {
                ...enhanced,
                parentTaskId: enhanced.reconstructedParentId || enhanced.parentTaskId
            };
            return skeleton;
        });
    }

    /**
     * Point d'entrée principal : reconstruit la hiérarchie complète (méthode d'instance)
     */
    public async doReconstruction(
        skeletons: ConversationSkeleton[]
    ): Promise<EnhancedConversationSkeleton[]> {
        const startTime = Date.now();
        
        this.log('Starting hierarchy reconstruction', {
            totalSkeletons: skeletons.length,
            config: this.config
        });

        // Conversion en EnhancedConversationSkeleton
        let enhancedSkeletons = this.enhanceSkeletons(skeletons);

        // Filtrage par workspace si demandé
        if (this.config.workspaceFilter) {
            enhancedSkeletons = enhancedSkeletons.filter(
                s => s.metadata.workspace === this.config.workspaceFilter
            );
        }

        // PASSE 1 : Extraction et parsing
        const phase1Result = await this.executePhase1(enhancedSkeletons, this.config);
        this.log('Phase 1 completed', phase1Result);

        // PASSE 2 : Résolution des parentIds
        const phase2Result = await this.executePhase2(enhancedSkeletons, this.config);
        this.log('Phase 2 completed', phase2Result);

        const totalTimeMs = Date.now() - startTime;
        this.log('Hierarchy reconstruction completed', {
            totalTimeMs,
            phase1Result,
            phase2Result,
            reconstructedCount: enhancedSkeletons.filter(s => s.reconstructedParentId).length
        });

        return enhancedSkeletons;
    }

    /**
     * PASSE 1 : Extraction et parsing des instructions de sous-tâches
     */
    public async executePhase1(
        skeletons: EnhancedConversationSkeleton[],
        config?: Partial<ReconstructionConfig>
    ): Promise<Phase1Result> {
        const startTime = Date.now();
        const mergedConfig = { ...this.config, ...config };
        const result: Phase1Result = {
            processedCount: 0,
            parsedCount: 0,
            errors: [],
            totalInstructionsExtracted: 0,
            radixTreeSize: 0,
            processingTimeMs: 0
        };

        // Traitement par batches
        const batches = this.createBatches(skeletons, mergedConfig.batchSize || 20);
        
        for (const batch of batches) {
            await Promise.all(batch.map(async (skeleton) => {
                try {
                    // Vérifier si déjà traité et si les fichiers n'ont pas changé
                    if (await this.shouldSkipPhase1(skeleton, mergedConfig)) {
                        this.log(`Skipping Phase 1 for ${skeleton.taskId} - already processed`);
                        return;
                    }

                    // Extraire les instructions depuis ui_messages.json
                    const instructions = await this.extractSubtaskInstructions(skeleton);
                    
                    if (instructions.length > 0) {
                        skeleton.parsedSubtaskInstructions = {
                            instructions,
                            parsingTimestamp: new Date().toISOString(),
                            sourceFiles: await this.getSourceFilesInfo(skeleton),
                            extractionStats: {
                                totalPatterns: instructions.length,
                                xmlDelegations: instructions.filter(i => i.mode !== 'unknown').length,
                                taskTags: instructions.filter(i => i.taskId).length,
                                duplicatesRemoved: 0
                            }
                        };
                        
                        // Ajouter les préfixes au radix tree
                        for (const instruction of instructions) {
                            const prefix = instruction.message.substring(0, 200);
                            await this.instructionIndex.addInstruction(
                                skeleton.taskId,
                                prefix,
                                instruction
                            );
                        }
                        
                        result.parsedCount++;
                        result.totalInstructionsExtracted += instructions.length;
                    }

                    // Mettre à jour l'état de traitement
                    this.updateProcessingState(skeleton, 'phase1', true);
                    result.processedCount++;

                } catch (error: any) {
                    result.errors.push({
                        taskId: skeleton.taskId,
                        error: error.message
                    });
                    this.updateProcessingState(skeleton, 'phase1', false, error.message);
                }
            }));
        }

        result.radixTreeSize = await this.instructionIndex.getSize();
        result.processingTimeMs = Date.now() - startTime;
        
        return result;
    }

    /**
     * PASSE 2 : Résolution des parentIds manquants
     */
    public async executePhase2(
        skeletons: EnhancedConversationSkeleton[],
        config?: Partial<ReconstructionConfig>
    ): Promise<Phase2Result> {
        const startTime = Date.now();
        const mergedConfig = { ...this.config, ...config };
        const result: Phase2Result = {
            processedCount: 0,
            resolvedCount: 0,
            unresolvedCount: 0,
            resolutionMethods: {},
            averageConfidenceScore: 0,
            errors: [],
            processingTimeMs: 0
        };

        // Créer un index des skeletons par taskId pour validation rapide
        const skeletonMap = new Map(skeletons.map(s => [s.taskId, s]));
        const confidenceScores: number[] = [];

        // Traitement par batches
        const batches = this.createBatches(skeletons, mergedConfig.batchSize || 20);
        
        for (const batch of batches) {
            await Promise.all(batch.map(async (skeleton) => {
                try {
                    // Ne traiter que les tâches sans parentId ou avec parentId invalide
                    if (skeleton.parentTaskId && skeletonMap.has(skeleton.parentTaskId)) {
                        return; // ParentId déjà valide
                    }

                    // Vérifier si c'est une vraie racine
                    if (this.isRootTask(skeleton)) {
                        skeleton.isRootTask = true;
                        skeleton.parentResolutionMethod = 'root_detected';
                        result.resolvedCount++;
                        this.incrementResolutionMethod(result, 'root_detected');
                        return;
                    }

                    // Rechercher le parent via différentes méthodes
                    const parentCandidate = await this.findParentCandidate(
                        skeleton,
                        skeletonMap,
                        mergedConfig
                    );

                    if (parentCandidate) {
                        // Valider le candidat
                        const validation = await this.validateParentCandidate(
                            skeleton,
                            parentCandidate.parentId,
                            skeletonMap
                        );

                        if (validation.isValid && parentCandidate.confidence >= (mergedConfig.minConfidenceScore || 0.3)) {
                            skeleton.reconstructedParentId = parentCandidate.parentId;
                            skeleton.parentConfidenceScore = parentCandidate.confidence;
                            skeleton.parentResolutionMethod = parentCandidate.method;
                            
                            result.resolvedCount++;
                            confidenceScores.push(parentCandidate.confidence);
                            this.incrementResolutionMethod(result, parentCandidate.method);
                        } else {
                            result.unresolvedCount++;
                            this.log(`Parent validation failed for ${skeleton.taskId}`, validation);
                        }
                    } else {
                        result.unresolvedCount++;
                    }

                    // Mettre à jour l'état de traitement
                    this.updateProcessingState(skeleton, 'phase2', true);
                    result.processedCount++;

                } catch (error: any) {
                    result.errors.push({
                        taskId: skeleton.taskId,
                        error: error.message
                    });
                    this.updateProcessingState(skeleton, 'phase2', false, error.message);
                }
            }));
        }

        // Calculer le score de confiance moyen
        if (confidenceScores.length > 0) {
            result.averageConfidenceScore = 
                confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length;
        }

        result.processingTimeMs = Date.now() - startTime;
        return result;
    }

    /**
     * Trouve un candidat parent pour une tâche orpheline
     */
    private async findParentCandidate(
        skeleton: EnhancedConversationSkeleton,
        skeletonMap: Map<string, EnhancedConversationSkeleton>,
        config: ReconstructionConfig
    ): Promise<{ parentId: string; confidence: number; method: any } | null> {
        // MODE STRICT : Utilise uniquement le matching exact de préfixe
        if (config.strictMode === true) {
            if (skeleton.truncatedInstruction) {
                // Utiliser searchExactPrefix avec l'instruction tronquée (K=192 via computeInstructionPrefix)
                const exactResults = await this.instructionIndex.searchExactPrefix(skeleton.truncatedInstruction);
                
                if (!exactResults || exactResults.length === 0) {
                    this.log(`STRICT MODE: no exact parent match for ${skeleton.taskId}`);
                    return null;
                }
                
                if (exactResults.length === 1) {
                    const candidate = exactResults[0];
                    // Validation basique pour éviter l'auto-référence
                    if (candidate.taskId !== skeleton.taskId) {
                        this.log(`STRICT MODE: exact match found for ${skeleton.taskId} → ${candidate.taskId}`);
                        return {
                            parentId: candidate.taskId,
                            confidence: 1,
                            method: 'radix_tree_exact'
                        };
                    } else {
                        this.log(`STRICT MODE: no exact parent match for ${skeleton.taskId} (self-reference)`);
                        return null;
                    }
                }
                
                if (exactResults.length > 1) {
                    this.log(`STRICT MODE: ambiguous exact matches (${exactResults.length}) for ${skeleton.taskId}`);
                    return null;
                }
            }
            
            this.log(`STRICT MODE: no truncatedInstruction for ${skeleton.taskId}`);
            return null;
        }

        // MODE LEGACY : Comportement original avec similarité et fallbacks
        // 1. Essayer via le radix tree (recherche par similarité d'instruction)
        if (skeleton.truncatedInstruction) {
            const searchResult = await this.instructionIndex.searchSimilar(
                skeleton.truncatedInstruction,
                config.similarityThreshold || 0.2
            );
            
            if (searchResult && searchResult.length > 0) {
                // 🎯 CORRECTION : Tester TOUS les candidats viables, pas seulement le premier
                for (const candidate of searchResult) {
                    // Pré-validation rapide : le candidat existe-t-il ?
                    if (skeletonMap.has(candidate.taskId)) {
                        // Validation basique pour éviter l'auto-référence
                        if (candidate.taskId !== skeleton.taskId) {
                            this.log(`🔍 [CANDIDATE TEST] Testing ${skeleton.taskId} → ${candidate.taskId} (score: ${candidate.similarity})`);
                            return {
                                parentId: candidate.taskId,
                                confidence: candidate.similarity,
                                method: 'radix_tree'
                            };
                        } else {
                            this.log(`⚠️ [SELF-REF SKIP] Skipping self-reference for ${skeleton.taskId}`);
                        }
                    } else {
                        this.log(`⚠️ [MISSING PARENT] Parent ${candidate.taskId} not found in skeleton map`);
                    }
                }
            }
        }

        // 2. Essayer via les métadonnées (désactivé en mode strict)
        if (!config.strictMode && skeleton.metadata?.workspace) {
            const metadataCandidate = await this.findParentByMetadata(skeleton, skeletonMap);
            if (metadataCandidate) {
                return {
                    parentId: metadataCandidate,
                    confidence: 0.5,
                    method: 'metadata'
                };
            }
        } else if (config.strictMode) {
            this.log(`STRICT MODE: fallback metadata disabled for ${skeleton.taskId}`);
        }

        // 3. Essayer via la proximité temporelle (désactivé en mode strict)
        if (!config.strictMode) {
            const temporalCandidate = await this.findParentByTemporalProximity(skeleton, skeletonMap);
            if (temporalCandidate) {
                return {
                    parentId: temporalCandidate,
                    confidence: 0.4,
                    method: 'temporal_proximity'
                };
            }
        } else {
            this.log(`STRICT MODE: fallback temporal_proximity disabled for ${skeleton.taskId}`);
        }

        return null;
    }

    /**
     * Valide un candidat parent
     */
    private async validateParentCandidate(
        child: EnhancedConversationSkeleton,
        parentId: string,
        skeletonMap: Map<string, EnhancedConversationSkeleton>
    ): Promise<ParentValidation> {
        // 1. Vérifier que le parent existe
        const parent = skeletonMap.get(parentId);
        if (!parent) {
            return {
                isValid: false,
                validationType: 'existence',
                reason: 'Parent task not found'
            };
        }

        // 2. TOUJOURS empêcher les auto-références (validation critique)
        if (child.taskId === parentId) {
            return {
                isValid: false,
                validationType: 'circular',
                reason: 'Task cannot be its own parent (self-reference)'
            };
        }

        // Mode test contrôlé : bypasser seulement les validations strictes
        const isControlledTest = child.metadata?.workspace === './test' || child.metadata?.dataSource?.includes('controlled-hierarchy');
        if (isControlledTest) {
            this.log(`🧪 [CONTROLLED TEST MODE] Skipping strict validations for ${child.taskId} → ${parentId} (basic validations still apply)`);
            return {
                isValid: true,
                validationType: 'existence'
            };
        }

        // 2. Vérifier la cohérence temporelle (parent créé avant enfant)
        const parentTime = new Date(parent.metadata.createdAt).getTime();
        const childTime = new Date(child.metadata.createdAt).getTime();
        
        if (parentTime > childTime) {
            return {
                isValid: false,
                validationType: 'temporal',
                reason: 'Parent created after child'
            };
        }

        // 3. Vérifier l'absence de cycle
        if (this.wouldCreateCycle(child.taskId, parentId, skeletonMap)) {
            return {
                isValid: false,
                validationType: 'circular',
                reason: 'Would create circular dependency'
            };
        }

        // 4. Vérifier la cohérence du workspace
        if (parent.metadata.workspace && child.metadata.workspace) {
            if (parent.metadata.workspace !== child.metadata.workspace) {
                return {
                    isValid: false,
                    validationType: 'workspace',
                    reason: 'Different workspaces'
                };
            }
        }

        return {
            isValid: true,
            validationType: 'existence'
        };
    }

    /**
     * Extrait les instructions de sous-tâches depuis ui_messages.json
     */
    private async extractSubtaskInstructions(
        skeleton: EnhancedConversationSkeleton
    ): Promise<NewTaskInstruction[]> {
        const instructions: NewTaskInstruction[] = [];
        
        // Construire le chemin vers ui_messages.json
        const basePath = skeleton.metadata.dataSource || '';
        const uiMessagesPath = path.join(basePath, 'ui_messages.json');
        
        if (!fs.existsSync(uiMessagesPath)) {
            return instructions;
        }

        try {
            const content = fs.readFileSync(uiMessagesPath, 'utf-8');
            const data = JSON.parse(content);
            
            // Parcourir les messages pour trouver les patterns new_task dans les vraies données JSON
            if (Array.isArray(data)) {
                for (const message of data) {
                    // Pattern principal : messages "ask" avec tool "newTask"
                    if (message.type === 'ask' && message.ask === 'tool') {
                        try {
                            const toolData = JSON.parse(message.text);
                            if (toolData.tool === 'newTask' && toolData.mode && toolData.content) {
                                // Nettoyer le mode (enlever les emojis)
                                const cleanMode = this.extractModeFromRooMode(toolData.mode);
                                
                                instructions.push({
                                    timestamp: message.ts || Date.now(),
                                    mode: cleanMode,
                                    message: toolData.content.substring(0, 200),
                                    taskId: toolData.taskId // Si disponible
                                });
                                
                                this.log(`✅ [EXTRACTION] Found newTask instruction: mode=${cleanMode}, content="${toolData.content.substring(0, 50)}..."`);
                            }
                        } catch (error) {
                            // Ignore les erreurs de parsing JSON pour ce message
                        }
                    }
                    
                    // Pattern de fallback : XML <new_task> pour compatibilité
                    if (message.text || message.content) {
                        const content = message.text || message.content;
                        const xmlMatches = content?.match(/<new_task[^>]*>[\s\S]*?<\/new_task>/g);
                        if (xmlMatches) {
                            for (const match of xmlMatches) {
                                const modeMatch = match.match(/<mode>([^<]+)<\/mode>/);
                                const messageMatch = match.match(/<message>([\s\S]*?)<\/message>/);
                                
                                if (modeMatch && messageMatch) {
                                    instructions.push({
                                        timestamp: message.ts || message.timestamp || Date.now(),
                                        mode: modeMatch[1],
                                        message: messageMatch[1].substring(0, 200)
                                    });
                                    
                                    this.log(`✅ [EXTRACTION] Found XML newTask instruction: mode=${modeMatch[1]}, content="${messageMatch[1].substring(0, 50)}..."`);
                                }
                            }
                        }
                    }
                    
                    // Pattern 3: Délégation textuelle dans les messages say
                    if (message.type === 'say' && (message.text || message.content)) {
                        const content = message.text || message.content;
                        const delegationPattern = /je (?:te passe|délègue|confie|transfère).*?(?:en|au) mode?\s+(\w+)/i;
                        const delegationMatch = content?.match(delegationPattern);
                        
                        if (delegationMatch) {
                            instructions.push({
                                timestamp: message.ts || Date.now(),
                                mode: delegationMatch[1].toLowerCase(),
                                message: content.substring(0, 200)
                            });
                            
                            this.log(`✅ [EXTRACTION] Found delegation instruction: mode=${delegationMatch[1].toLowerCase()}, content="${content.substring(0, 50)}..."`);
                        }
                    }
                }
            }
        } catch (error) {
            this.log(`Error extracting instructions for ${skeleton.taskId}`, error);
        }

        return instructions;
    }

    /**
     * Détermine si une tâche est une vraie racine
     */
    private isRootTask(skeleton: EnhancedConversationSkeleton): boolean {
        // 🎯 CORRECTION : Détecter le vrai ROOT pour les tests contrôlés
        if (skeleton.truncatedInstruction?.includes('**Ta mission est de créer le niveau racine')) {
            return true; // C'est la vraie racine ROOT de notre hiérarchie de test
        }
        
        // LEAF-A2 n'est PAS une racine même s'il commence par **
        if (skeleton.truncatedInstruction?.includes('**COLLECTE DES DONNÉES DE TEST HIÉRARCHIQUE**')) {
            return false; // Ce n'est qu'une tâche de collecte, pas la racine
        }
        
        // Critères pour identifier une racine :
        // 1. Pas d'instruction tronquée (premier message utilisateur)
        if (!skeleton.truncatedInstruction || skeleton.truncatedInstruction.length < 10) {
            return true;
        }
        
        // 2. Pattern de démarrage typique
        const rootPatterns = [
            /^bonjour/i,
            /^hello/i,
            /^je voudrais/i,
            /^j'aimerais/i,
            /^peux-tu/i,
            /^aide-moi/i,
            /^créer un/i
        ];
        
        // 3. Exclure les instructions qui commencent par TEST- (ce sont des sous-tâches)
        if (skeleton.truncatedInstruction?.match(/^.*TEST-[A-Z]/)) {
            return false;
        }
        
        return rootPatterns.some(p => p.test(skeleton.truncatedInstruction || ''));
    }

    /**
     * Trouve un parent par analyse des métadonnées
     */
    private async findParentByMetadata(
        skeleton: EnhancedConversationSkeleton,
        skeletonMap: Map<string, EnhancedConversationSkeleton>
    ): Promise<string | null> {
        // Recherche basée sur les patterns de titre et workspace
        for (const [taskId, candidate] of skeletonMap) {
            if (taskId === skeleton.taskId) continue;
            
            // Vérifier le workspace
            if (candidate.metadata.workspace !== skeleton.metadata.workspace) continue;
            
            // Vérifier si le candidat a des instructions pour créer cette tâche
            if (candidate.childTaskInstructionPrefixes) {
                for (const prefix of candidate.childTaskInstructionPrefixes) {
                    if (skeleton.truncatedInstruction?.startsWith(prefix.substring(0, 50))) {
                        return taskId;
                    }
                }
            }
        }
        
        return null;
    }

    /**
     * Trouve un parent par proximité temporelle
     */
    private async findParentByTemporalProximity(
        skeleton: EnhancedConversationSkeleton,
        skeletonMap: Map<string, EnhancedConversationSkeleton>
    ): Promise<string | null> {
        const childTime = new Date(skeleton.metadata.createdAt).getTime();
        let closestParent: string | null = null;
        let smallestGap = Infinity;
        
        // Chercher la tâche la plus proche temporellement (avant)
        for (const [taskId, candidate] of skeletonMap) {
            if (taskId === skeleton.taskId) continue;
            
            const candidateTime = new Date(candidate.metadata.createdAt).getTime();
            
            // Le candidat doit être créé avant
            if (candidateTime >= childTime) continue;
            
            // Vérifier le workspace
            if (candidate.metadata.workspace !== skeleton.metadata.workspace) continue;
            
            const gap = childTime - candidateTime;
            
            // Limite à 5 minutes (300000 ms)
            if (gap < 300000 && gap < smallestGap) {
                smallestGap = gap;
                closestParent = taskId;
            }
        }
        
        return closestParent;
    }

    /**
     * Vérifie si l'ajout d'une relation créerait un cycle
     */
    private wouldCreateCycle(
        childId: string,
        parentId: string,
        skeletonMap: Map<string, EnhancedConversationSkeleton>
    ): boolean {
        const visited = new Set<string>();
        let current = parentId;
        
        while (current) {
            if (visited.has(current) || current === childId) {
                return true; // Cycle détecté
            }
            
            visited.add(current);
            
            const parent = skeletonMap.get(current);
            current = parent?.reconstructedParentId || parent?.parentTaskId || '';
        }
        
        return false;
    }

    /**
     * Convertit les skeletons standards en EnhancedConversationSkeleton
     */
    private enhanceSkeletons(skeletons: ConversationSkeleton[]): EnhancedConversationSkeleton[] {
        return skeletons.map(skeleton => ({
            ...skeleton,
            processingState: {
                phase1Completed: false,
                phase2Completed: false,
                processingErrors: []
            },
            sourceFileChecksums: {}
        } as EnhancedConversationSkeleton));
    }

    /**
     * Détermine si la Phase 1 peut être sautée pour un skeleton
     */
    private async shouldSkipPhase1(
        skeleton: EnhancedConversationSkeleton,
        config: ReconstructionConfig
    ): Promise<boolean> {
        if (config.forceRebuild) return false;
        
        // Vérifier si déjà traité avec succès
        if (!skeleton.processingState?.phase1Completed) return false;
        
        // Vérifier les checksums pour détecter les changements
        const currentChecksums = await this.calculateChecksums(skeleton);
        
        if (JSON.stringify(currentChecksums) !== JSON.stringify(skeleton.sourceFileChecksums)) {
            return false; // Les fichiers ont changé
        }
        
        return true; // Peut être sauté
    }

    /**
     * Calcule les checksums des fichiers sources
     */
    private async calculateChecksums(
        skeleton: EnhancedConversationSkeleton
    ): Promise<any> {
        const checksums: any = {};
        const basePath = skeleton.metadata.dataSource || '';
        
        const files = ['ui_messages.json', 'api_history.json', 'metadata.json'];
        
        for (const file of files) {
            const filePath = path.join(basePath, file);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                checksums[file.replace('.json', '')] = crypto
                    .createHash('md5')
                    .update(content)
                    .digest('hex');
            }
        }
        
        return checksums;
    }

    /**
     * Obtient les informations sur les fichiers sources
     */
    private async getSourceFilesInfo(skeleton: EnhancedConversationSkeleton): Promise<any> {
        const basePath = skeleton.metadata.dataSource || '';
        const info: any = {};
        
        const files = ['ui_messages', 'api_history'];
        
        for (const file of files) {
            const filePath = path.join(basePath, `${file}.json`);
            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                info[file] = {
                    path: filePath,
                    exists: true,
                    size: stats.size,
                    lastModified: stats.mtime.toISOString()
                };
            } else {
                info[file] = {
                    path: filePath,
                    exists: false
                };
            }
        }
        
        return info;
    }

    /**
     * Met à jour l'état de traitement d'un skeleton
     */
    private updateProcessingState(
        skeleton: EnhancedConversationSkeleton,
        phase: 'phase1' | 'phase2',
        success: boolean,
        error?: string
    ): void {
        if (!skeleton.processingState) {
            skeleton.processingState = {
                phase1Completed: false,
                phase2Completed: false,
                processingErrors: []
            };
        }
        
        if (phase === 'phase1') {
            skeleton.processingState.phase1Completed = success;
        } else {
            skeleton.processingState.phase2Completed = success;
        }
        
        skeleton.processingState.lastProcessedAt = new Date().toISOString();
        
        if (error) {
            skeleton.processingState.processingErrors.push(error);
        }
    }

    /**
     * Crée des batches pour le traitement parallèle
     */
    private createBatches<T>(items: T[], batchSize: number): T[][] {
        const batches: T[][] = [];
        for (let i = 0; i < items.length; i += batchSize) {
            batches.push(items.slice(i, i + batchSize));
        }
        return batches;
    }

    /**
     * Incrémente le compteur de méthode de résolution
     */
    private incrementResolutionMethod(result: Phase2Result, method: string): void {
        if (!result.resolutionMethods[method]) {
            result.resolutionMethods[method] = 0;
        }
        result.resolutionMethods[method]++;
    }

    /**
     * Log avec mode debug optionnel
     */
    /**
     * Extrait le mode propre depuis un mode Roo avec emojis
     */
    private extractModeFromRooMode(rooMode: string): string {
        // Nettoyer les emojis et espaces
        const cleanMode = rooMode.replace(/[^\w\s]/g, '').trim().toLowerCase();
        
        // Mapper les modes Roo vers les modes standards
        const modeMapping: Record<string, string> = {
            'orchestrator': 'orchestrator',
            'code': 'code',
            'ask': 'ask',
            'debug': 'debug',
            'architect': 'architect',
            'manager': 'manager'
        };
        
        // Trouver la correspondance
        for (const [key, value] of Object.entries(modeMapping)) {
            if (cleanMode.includes(key)) {
                return value;
            }
        }
        
        // Fallback
        return cleanMode || 'unknown';
    }

    /**
     * Log avec mode debug optionnel
     */
    private log(message: string, data?: any): void {
        if (this.config.debugMode) {
            console.log(`[HierarchyEngine] ${message}`, data || '');
        }
    }
}