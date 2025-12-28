/**
 * Fixtures de test pour le système de reconstruction hiérarchique
 * Contient des données réalistes pour valider le bon fonctionnement
 */

import type { ConversationSkeleton, NewTaskInstruction } from '../../src/types/conversation.js';
import type { EnhancedConversationSkeleton } from '../../src/types/enhanced-hierarchy.js';

/**
 * Données de test pour les skeletons de conversations
 */
export const mockSkeletons: ConversationSkeleton[] = [
    // Tâche racine
    {
        taskId: 'root-task-001',
        parentTaskId: undefined,
        truncatedInstruction: 'Bonjour, je voudrais créer un système de tests',
        metadata: {
            createdAt: '2025-01-15T10:00:00Z',
            lastActivity: '2025-01-15T10:10:00Z',
            title: 'Création système de tests',
            workspace: 'd:/dev/test-project',
            mode: 'ask',
            messageCount: 5,
            actionCount: 2,
            totalSize: 5000,
            dataSource: 'd:/roo-data/root-task-001'
        },
        sequence: [],
        childTaskInstructionPrefixes: [
            '**MISSION DEBUG CRITIQUE : Réparation du système hiérarchique pour résoudre les 47 tâches orphelines**',
            '**MISSION CORRECTIVE FINALE : Validation et documentation du système de reconstruction**'
        ],
        isCompleted: false
    },
    
    // Enfant avec parentId valide
    {
        taskId: 'child-task-002',
        parentTaskId: 'root-task-001',
        truncatedInstruction: '**MISSION DEBUG CRITIQUE : Réparation du système hiérarchique pour résoudre les 47 tâches orphelines**',
        metadata: {
            createdAt: '2025-01-15T10:05:00Z',
            lastActivity: '2025-01-15T10:20:00Z',
            title: 'Debug système hiérarchique',
            workspace: 'd:/dev/test-project',
            mode: 'code',
            messageCount: 12,
            actionCount: 5,
            totalSize: 12000,
            dataSource: 'd:/roo-data/child-task-002'
        },
        sequence: [],
        isCompleted: true
    },
    
    // Tâche orpheline (parentId manquant)
    {
        taskId: 'orphan-task-003',
        parentTaskId: undefined,
        truncatedInstruction: '**MISSION CORRECTIVE FINALE : Validation et documentation du système de reconstruction**',
        metadata: {
            createdAt: '2025-01-15T10:10:00Z',
            lastActivity: '2025-01-15T10:25:00Z',
            title: 'Validation système',
            workspace: 'd:/dev/test-project',
            mode: 'code',
            messageCount: 8,
            actionCount: 3,
            totalSize: 8000,
            dataSource: 'd:/roo-data/orphan-task-003'
        },
        sequence: [],
        isCompleted: false
    },
    
    // Tâche orpheline avec parentId invalide
    {
        taskId: 'invalid-parent-004',
        parentTaskId: 'non-existent-task',
        truncatedInstruction: 'Créer une architecture modulaire pour le projet',
        metadata: {
            createdAt: '2025-01-15T10:15:00Z',
            lastActivity: '2025-01-15T10:35:00Z',
            title: 'Architecture modulaire',
            workspace: 'd:/dev/test-project',
            mode: 'architect',
            messageCount: 15,
            actionCount: 7,
            totalSize: 15000,
            dataSource: 'd:/roo-data/invalid-parent-004'
        },
        sequence: [],
        childTaskInstructionPrefixes: ['Implémenter module X'],
        isCompleted: false
    },
    
    // Tâche d'un autre workspace (pour test isolation)
    {
        taskId: 'other-workspace-005',
        parentTaskId: undefined,
        truncatedInstruction: 'Analyser les logs du système',
        metadata: {
            createdAt: '2025-01-15T11:00:00Z',
            lastActivity: '2025-01-15T11:05:00Z',
            title: 'Analyse logs',
            workspace: 'd:/dev/other-project',
            mode: 'debug',
            messageCount: 3,
            actionCount: 1,
            totalSize: 3000,
            dataSource: 'd:/roo-data/other-workspace-005'
        },
        sequence: [],
        isCompleted: true
    },
    
    // Tâche créée avant son supposé parent (test validation temporelle)
    {
        taskId: 'time-paradox-006',
        parentTaskId: 'future-parent-007',
        truncatedInstruction: 'Implémenter la fonctionnalité X',
        metadata: {
            createdAt: '2025-01-15T09:00:00Z',
            lastActivity: '2025-01-15T09:30:00Z',
            title: 'Implémentation X',
            workspace: 'd:/dev/test-project',
            mode: 'code',
            messageCount: 10,
            actionCount: 4,
            totalSize: 10000,
            dataSource: 'd:/roo-data/time-paradox-006'
        },
        sequence: [],
        isCompleted: false
    },
    
    // Parent créé après l'enfant (invalide)
    {
        taskId: 'future-parent-007',
        parentTaskId: undefined,
        truncatedInstruction: 'Planifier le développement',
        metadata: {
            createdAt: '2025-01-15T12:00:00Z',
            lastActivity: '2025-01-15T12:15:00Z',
            title: 'Planification',
            workspace: 'd:/dev/test-project',
            mode: 'architect',
            messageCount: 6,
            actionCount: 2,
            totalSize: 6000,
            dataSource: 'd:/roo-data/future-parent-007'
        },
        sequence: [],
        isCompleted: false
    }
];

/**
 * Instructions new_task extraites pour les tests
 */
export const mockNewTaskInstructions: Record<string, NewTaskInstruction[]> = {
    'root-task-001': [
        {
            timestamp: 1705315500000,
            mode: 'code',
            message: '**MISSION DEBUG CRITIQUE : Réparation du système hiérarchique pour résoudre les 47 tâches orphelines**'
        },
        {
            timestamp: 1705315800000,
            mode: 'code',
            message: '**MISSION CORRECTIVE FINALE : Validation et documentation du système de reconstruction**'
        }
    ],
    'child-task-002': [
        {
            timestamp: 1705316100000,
            mode: 'architect',
            message: 'Créer une architecture modulaire pour le projet'
        }
    ],
    'future-parent-007': [
        {
            timestamp: 1705322400000,
            mode: 'code',
            message: 'Implémenter la fonctionnalité X'
        }
    ]
};

/**
 * Messages UI mockés pour extraction d'instructions
 * Format réaliste avec les 5 patterns attendus par le moteur d'extraction
 */
export const mockUiMessages = {
    'root-task-001': [
        // Message utilisateur standard
        {
            type: 'ask',
            ask: 'user',
            text: 'Bonjour, je voudrais créer un système de tests',
            ts: 1705315200000
        },
        
        // PATTERN 1: Messages "ask" avec tool "newTask" (format JSON)
        {
            type: 'ask',
            ask: 'tool',
            text: JSON.stringify({
                tool: 'newTask',
                mode: '💻 code',
                content: '**MISSION DEBUG CRITIQUE : Réparation du système hiérarchique pour résoudre les 47 tâches orphelines**',
                taskId: 'debug-hierarchy-001'
            }),
            ts: 1705315500000
        },
        
        // PATTERN 2: Messages "say/api_req_started" avec "[new_task in X mode: '...']"
        {
            type: 'say',
            say: 'api_req_started',
            text: JSON.stringify({
                request: "Creating new task: [new_task in 💻 code mode: '**MISSION CORRECTIVE FINALE : Validation et documentation du système de reconstruction**']",
                timestamp: 1705315800000
            }),
            ts: 1705315800000
        },
        
        // PATTERN 3: Messages avec balises XML <new_task>
        {
            type: 'say',
            say: 'text',
            text: 'Je vais créer une tâche de validation : <new_task><mode>code</mode><message>Valider les corrections apportées au système</message></new_task>',
            ts: 1705316100000
        },
        
        // PATTERN 4: XML générique avec balises personnalisées
        {
            type: 'say',
            say: 'text',
            text: 'Délégation complexe : <orchestrator_complex><mode>orchestrator</mode><message>Orchestrer les sous-tâches de validation finale</message></orchestrator_complex>',
            ts: 1705316400000
        },
        
        // PATTERN 5: Balises <task> simples
        {
            type: 'say',
            say: 'text',
            text: 'Petite tâche rapide : <task>Vérifier la cohérence des données de test</task>',
            ts: 1705316700000
        }
    ],
    
    'child-task-002': [
        // Message utilisateur avec instruction
        {
            type: 'ask',
            ask: 'user',
            text: '**MISSION DEBUG CRITIQUE : Réparation du système hiérarchique pour résoudre les 47 tâches orphelines**',
            ts: 1705315800000
        },
        
        // PATTERN 1: Tool newTask avec mode architect
        {
            type: 'ask',
            ask: 'tool',
            text: JSON.stringify({
                tool: 'newTask',
                mode: '🏗️ architect',
                content: 'Créer une architecture modulaire pour le projet',
                taskId: 'arch-modular-002'
            }),
            ts: 1705316100000
        },
        
        // PATTERN 3: XML new_task avec espaces et sauts de ligne
        {
            type: 'say',
            say: 'text',
            text: `<new_task>
    <mode>debug</mode>
    <message>
        Debugger le système de cache mémoire
    </message>
</new_task>`,
            ts: 1705316400000
        },
        
        // PATTERN 5: Multiple task tags
        {
            type: 'say',
            say: 'text',
            text: 'Actions requises : <task>Analyser les dépendances</task> puis <task>Implémenter les tests unitaires</task>',
            ts: 1705316700000
        }
    ],
    
    'orphan-task-003': [
        // Messages avec patterns variés pour une tâche orpheline
        {
            type: 'ask',
            ask: 'user',
            text: '**MISSION CORRECTIVE FINALE : Validation et documentation du système de reconstruction**',
            ts: 1705316200000
        },
        
        // PATTERN 2: API request avec new_task
        {
            type: 'say',
            say: 'api_req_started',
            text: JSON.stringify({
                request: "Initiating validation: [new_task in 📝 ask mode: 'Documenter les patterns d\\'extraction utilisés']",
                timestamp: 1705316500000
            }),
            ts: 1705316500000
        },
        
        // PATTERN 4: XML personnalisé complexe
        {
            type: 'say',
            say: 'text',
            text: 'Validation avancée : <validation_complex><mode>code</mode><message>Valider tous les patterns d\\\'extraction XML</message></validation_complex>',
            ts: 1705316800000
        }
    ],
    
    'invalid-parent-004': [
        // Messages pour tester la robustesse avec parentId invalide
        {
            type: 'ask',
            ask: 'user',
            text: 'Créer une architecture modulaire pour le projet',
            ts: 1705316300000
        },
        
        // PATTERN avec JSON malformé (doit être ignoré)
        {
            type: 'ask',
            ask: 'tool',
            text: '{"tool": "newTask", "mode": "code", "content": "JSON incomplet',
            ts: 1705316600000
        },
        
        // PATTERN 3 valide
        {
            type: 'say',
            say: 'text',
            text: '<new_task><mode>architect</mode><message>Créer une architecture modulaire pour le projet</message></new_task>',
            ts: 1705316900000
        }
    ],
    
    'time-paradox-006': [
        // Messages pour tester la validation temporelle
        {
            type: 'ask',
            ask: 'user',
            text: 'Implémenter la fonctionnalité X',
            ts: 1705315400000
        },
        
        // PATTERN 1 avec timestamp antérieur au parent
        {
            type: 'ask',
            ask: 'tool',
            text: JSON.stringify({
                tool: 'newTask',
                mode: '💻 code',
                content: 'Implémenter la fonctionnalité X avant la planification',
                taskId: 'impl-x-006'
            }),
            ts: 1705315700000
        }
    ],
    
    'future-parent-007': [
        // Messages pour le parent créé après l'enfant
        {
            type: 'ask',
            ask: 'user',
            text: 'Planifier le développement',
            ts: 1705320000000
        },
        
        // PATTERN 2: API request pour planification
        {
            type: 'say',
            say: 'api_req_started',
            text: JSON.stringify({
                request: "Planning phase: [new_task in 🏗️ architect mode: 'Planifier le développement de la fonctionnalité X']",
                timestamp: 1705320300000
            }),
            ts: 1705320300000
        }
    ]
};

/**
 * Cas de test pour validation de cycles
 */
export const mockCyclicSkeletons: ConversationSkeleton[] = [
    {
        taskId: 'cycle-a',
        parentTaskId: 'cycle-c', // Crée un cycle : A -> C -> B -> A
        truncatedInstruction: 'Tâche A du cycle',
        metadata: {
            createdAt: '2025-01-15T10:00:00Z',
            lastActivity: '2025-01-15T10:05:00Z',
            title: 'Cycle A',
            workspace: 'd:/dev/test-project',
            mode: 'code',
            messageCount: 5,
            actionCount: 2,
            totalSize: 5000,
            dataSource: 'd:/roo-data/cycle-a'
        },
        sequence: [],
        isCompleted: false
    },
    {
        taskId: 'cycle-b',
        parentTaskId: 'cycle-a',
        truncatedInstruction: 'Tâche B du cycle',
        metadata: {
            createdAt: '2025-01-15T10:01:00Z',
            lastActivity: '2025-01-15T10:06:00Z',
            title: 'Cycle B',
            workspace: 'd:/dev/test-project',
            mode: 'code',
            messageCount: 5,
            actionCount: 2,
            totalSize: 5000,
            dataSource: 'd:/roo-data/cycle-b'
        },
        sequence: [],
        isCompleted: false
    },
    {
        taskId: 'cycle-c',
        parentTaskId: 'cycle-b',
        truncatedInstruction: 'Tâche C du cycle',
        metadata: {
            createdAt: '2025-01-15T10:02:00Z',
            lastActivity: '2025-01-15T10:07:00Z',
            title: 'Cycle C',
            workspace: 'd:/dev/test-project',
            mode: 'code',
            messageCount: 5,
            actionCount: 2,
            totalSize: 5000,
            dataSource: 'd:/roo-data/cycle-c'
        },
        sequence: [],
        isCompleted: false
    }
];

/**
 * Pattern XML complexes pour tests d'extraction
 */
export const complexXmlPatterns = [
    // Pattern new_task standard
    '<new_task><mode>code</mode><message>Créer un module de test</message></new_task>',
    
    // Pattern avec attributs
    '<new_task id="123"><mode>architect</mode><message>Planifier architecture</message></new_task>',
    
    // Pattern avec espaces et sauts de ligne
    `<new_task>
        <mode>debug</mode>
        <message>
            Debugger le système de cache
        </message>
    </new_task>`,
    
    // Pattern de délégation complexe
    '<orchestrator_complex><mode>orchestrator</mode><message>Orchestrer les sous-tâches</message></orchestrator_complex>',
    
    // Pattern task simple
    '<task>Implémenter la fonctionnalité de recherche</task>',
    
    // Pattern imbriqué
    'Voici la tâche : <task>Analyser <b>tous</b> les fichiers du projet</task> pour optimisation'
];

/**
 * Données pour tests de performance (1000+ entrées)
 */
export function generateLargeDataset(count: number = 1000): ConversationSkeleton[] {
    const skeletons: ConversationSkeleton[] = [];
    const baseTime = new Date('2025-01-15T10:00:00Z').getTime();
    
    // Créer une hiérarchie profonde
    for (let i = 0; i < count; i++) {
        const isRoot = i % 10 === 0;
        const parentId = isRoot ? undefined : `task-${Math.max(0, i - 1)}`;
        
        skeletons.push({
            taskId: `task-${i}`,
            parentTaskId: parentId,
            truncatedInstruction: `Mission ${i}: ${isRoot ? 'Créer' : 'Implémenter'} fonctionnalité ${i}`,
            metadata: {
                createdAt: new Date(baseTime + i * 60000).toISOString(),
                lastActivity: new Date(baseTime + (i + 1) * 60000).toISOString(),
                title: `Tâche ${i}`,
                workspace: `d:/dev/project-${Math.floor(i / 100)}`,
                mode: ['code', 'architect', 'debug', 'ask'][i % 4] as any,
                messageCount: 5 + (i % 20),
                actionCount: 2 + (i % 10),
                totalSize: 5000 + (i % 20) * 1000,
                dataSource: `d:/roo-data/task-${i}`
            },
            sequence: [],
            childTaskInstructionPrefixes: isRoot ? [`Mission ${i+1}: Implémenter fonctionnalité ${i+1}`] : undefined,
            isCompleted: i % 3 === 0
        });
    }
    
    return skeletons;
}

/**
 * Helper pour créer un EnhancedConversationSkeleton à partir d'un ConversationSkeleton
 */
export function enhanceSkeleton(skeleton: ConversationSkeleton): EnhancedConversationSkeleton {
    return {
        ...skeleton,
        processingState: {
            phase1Completed: false,
            phase2Completed: false,
            processingErrors: []
        },
        sourceFileChecksums: {}
    };
}

/**
 * Données corrompues pour tests de robustesse
 */
export const corruptedData = {
    // Skeleton avec métadonnées manquantes
    missingMetadata: {
        taskId: 'corrupt-001',
        parentTaskId: undefined,
        truncatedInstruction: 'Test corruption',
        // metadata manquant volontairement
        sequence: [],
        isCompleted: false
    } as any as ConversationSkeleton,
    
    // Skeleton avec taskId invalide
    invalidTaskId: {
        taskId: '',
        parentTaskId: 'root-task-001',
        truncatedInstruction: 'Test taskId invalide',
        metadata: {
            createdAt: '2025-01-15T10:00:00Z',
            lastActivity: '2025-01-15T10:05:00Z',
            title: 'Invalid ID',
            workspace: 'd:/dev/test',
            mode: 'code',
            messageCount: 1,
            actionCount: 0,
            totalSize: 1000,
            dataSource: 'd:/roo-data/invalid'
        },
        sequence: [],
        isCompleted: false
    },
    
    // Messages UI avec JSON invalide
    invalidJsonMessages: '{"messages": [{"role": "user", "content": "Test"',
    
    // Messages UI avec structure incorrecte
    malformedMessages: {
        data: 'not an array'
    }
};

/**
 * Configuration de test par défaut
 */
export const defaultTestConfig = {
    batchSize: 5,
    similarityThreshold: 0.2,
    minConfidenceScore: 0.3,
    debugMode: false,
    operationTimeout: 5000,
    forceRebuild: false
};