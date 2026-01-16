#!/usr/bin/env ts-node

import * as fs from 'fs/promises';
import * as path from 'path';
import { RooStorageDetector } from './utils/roo-storage-detector.js';
import { GenericError, GenericErrorCode } from './types/errors.js';

async function debugHierarchy() {
    console.log("🔍 DEBUG: Analyse de la hiérarchie...\n");
    
    const workspace = "d:/dev/2025-Epita-Intelligence-Symbolique";
    const detector = new RooStorageDetector();
    
    try {
        // Détection du storage
        const storageResult = await RooStorageDetector.detectRooStorage();
        console.log("✅ Storage détecté\n");
        
        // Obtenir les conversations du workspace
        // Utiliser le premier location trouvé
        const firstLocation = storageResult.locations?.[0];
        if (!firstLocation) {
            throw new GenericError('Aucun emplacement de stockage trouvé', GenericErrorCode.FILE_SYSTEM_ERROR);
        }
        const conversationsDir = path.join(
            firstLocation.path,
            'tasks'
        );
        
        // Lire quelques fichiers pour analyser la structure
        console.log("📂 Lecture d'exemples de conversations...\n");
        
        const entries = await fs.readdir(conversationsDir);
        let count = 0;
        
        for (const entry of entries.slice(0, 3)) { // Analyser les 3 premiers
            if (entry.endsWith('.json')) {
                const filePath = path.join(conversationsDir, entry);
                const content = await fs.readFile(filePath, 'utf-8');
                const data = JSON.parse(content);
                
                console.log(`\n📄 Fichier: ${entry}`);
                console.log(`  - taskId: ${data.conversationId || data.id || 'N/A'}`);
                console.log(`  - workspace: ${data.workspaceDirectory || 'N/A'}`);
                
                // Chercher où se trouve le parentTaskId
                console.log(`  - Clés racines: ${Object.keys(data).join(', ')}`);
                
                // Vérifier dans agentDetails
                if (data.agentDetails) {
                    console.log(`  - agentDetails.parentTaskId: ${data.agentDetails.parentTaskId || 'NON TROUVÉ'}`);
                }
                
                // Vérifier directement à la racine
                if (data.parentTaskId) {
                    console.log(`  - parentTaskId (racine): ${data.parentTaskId}`);
                }
                
                // Vérifier dans metadata
                if (data.metadata) {
                    console.log(`  - metadata.parentTaskId: ${data.metadata.parentTaskId || 'NON TROUVÉ'}`);
                }
                
                // Vérifier dans les messages pour les instructions new_task
                if (data.apiHistory && data.apiHistory.messages) {
                    const newTaskInstructions = [];
                    for (const msg of data.apiHistory.messages) {
                        if (msg.content && msg.content.includes('<new_task>')) {
                            newTaskInstructions.push('TROUVÉ');
                            break;
                        }
                    }
                    console.log(`  - Instructions new_task: ${newTaskInstructions.length > 0 ? 'OUI' : 'NON'}`);
                }
                
                count++;
                if (count >= 3) break;
            }
        }
        
    } catch (error) {
        console.error("❌ Erreur:", error);
    }
}

debugHierarchy();