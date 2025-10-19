// SDDD Phase 3D - Generate All Fixtures
// Single Direction, Deterministic, Debuggable

const fs = require('fs');
const path = require('path');

console.log('=== SDDD PHASE 3D: GENERATE ALL FIXTURES ===');
console.log('Approche: Single Direction, Deterministic, Debuggable');

const testIds = [
    '03deadab-a06d-4b29-976d-3cc142add1d9',
    '38948ef0-4a8b-40a2-ae29-b38d2aa9d5a7',
    'b423bff7-6fec-40fe-a00e-bb2a0ebb52f4',
    '8c06d62c-1ee2-4c3a-991e-c9483e90c8aa',
    'd6a6a99a-b7fd-41fc-86ce-2f17c9520437'
];

const baseDirs = [
    'tests/unit/utils/fixtures/controlled-hierarchy',
    'tests/integration/fixtures/controlled-hierarchy'
];

// Fonction pour créer un fichier avec encodage UTF-8 sans BOM
function createFile(filePath, content) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    // Écrire avec encodage UTF-8 sans BOM
    fs.writeFileSync(filePath, content, { encoding: 'utf8' });
    console.log(`SDDD: Créé ${filePath} (${content.length} caractères)`);
}

// Fonction pour générer des données déterministes
function generateTestData(testId, type) {
    const hash = require('crypto').createHash('md5').update(testId).digest();
    const seed = hash.readInt32BE(0);
    const random = (max) => Math.abs(seed + testId.charCodeAt(0)) % max;
    
    if (type === 'task_metadata') {
        return {
            workspace: "test-workspace",
            createdAt: "2025-10-17T21:56:00.000Z",
            parentTaskId: "",
            messageCount: 5 + random(5),
            truncatedInstruction: `Phase 3D Hierarchy Reconstruction Execution SDDD - ${testId}`,
            taskId: testId,
            lastActivity: "2025-10-17T21:56:00.000Z",
            actionCount: 3 + random(3),
            totalSize: 1024 + random(1024),
            title: `Tache Racine - ${testId}`,
            depth: 0,
            lastMessageAt: "2025-10-17T21:56:00.000Z"
        };
    }
    
    if (type === 'ui_messages') {
        return [
            {
                id: "msg-1",
                type: "user",
                content: `Message utilisateur 1 pour ${testId}`,
                timestamp: "2025-10-17T21:55:00.000Z"
            },
            {
                id: "msg-2",
                type: "assistant",
                content: `Message assistant 1 pour ${testId}`,
                timestamp: "2025-10-17T21:55:30.000Z"
            },
            {
                id: "msg-3",
                type: "user",
                content: `Message utilisateur 2 pour ${testId}`,
                timestamp: "2025-10-17T21:56:00.000Z"
            }
        ];
    }
    
    if (type === 'api_history') {
        return [
            {
                role: "user",
                content: `Début de la tâche ${testId}`,
                timestamp: "2025-10-17T21:55:00.000Z"
            },
            {
                role: "assistant",
                content: `Traitement en cours pour ${testId}`,
                timestamp: "2025-10-17T21:55:30.000Z"
            },
            {
                role: "user",
                content: `Fin de la tâche ${testId}`,
                timestamp: "2025-10-17T21:56:00.000Z"
            }
        ];
    }
}

console.log('SDDD: Génération des fixtures...');

let filesCreated = 0;
const filesExpected = testIds.length * baseDirs.length * 3; // 3 fichiers par test ID par répertoire

testIds.forEach(testId => {
    console.log(`SDDD: Traitement de ${testId}...`);
    
    baseDirs.forEach(baseDir => {
        // task_metadata.json
        const taskMetadata = generateTestData(testId, 'task_metadata');
        createFile(
            path.join(baseDir, testId, 'task_metadata.json'),
            JSON.stringify(taskMetadata)
        );
        filesCreated++;
        
        // ui_messages.json
        const uiMessages = generateTestData(testId, 'ui_messages');
        createFile(
            path.join(baseDir, testId, 'ui_messages.json'),
            JSON.stringify(uiMessages)
        );
        filesCreated++;
        
        // api_history.jsonl
        const apiHistory = generateTestData(testId, 'api_history');
        const apiHistoryJsonl = apiHistory.map(item => JSON.stringify(item)).join('\n');
        createFile(
            path.join(baseDir, testId, 'api_history.jsonl'),
            apiHistoryJsonl
        );
        filesCreated++;
    });
});

console.log('=== RAPPORT SDDD ===');
console.log(`Fichiers créés: ${filesCreated}/${filesExpected}`);
console.log(`Tests IDs traités: ${testIds.length}`);

if (filesCreated === filesExpected) {
    console.log('✅ SDDD: Toutes les fixtures créées avec succès (sans BOM)');
    process.exit(0);
} else {
    console.log('❌ SDDD: Erreur lors de la création des fixtures');
    process.exit(1);
}