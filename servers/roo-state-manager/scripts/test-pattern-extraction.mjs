#!/usr/bin/env node
/**
 * Script pour tester l'extraction avec le nouveau pattern
 */

import { RooStorageDetector } from '../build/src/utils/roo-storage-detector.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const STORAGE_BASE = 'C:\\Users\\jsboi\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline';
const TARGET_WORKSPACE = 'd:/dev/roo-extensions';

async function main() {
    console.log('🧪 TEST: Extraction avec nouveau pattern\n');
    
    const tasksDir = path.join(STORAGE_BASE, 'tasks');
    const conversationDirs = await fs.readdir(tasksDir, { withFileTypes: true });
    
    let tested = 0;
    
    for (const convDir of conversationDirs) {
        if (!convDir.isDirectory() || convDir.name === '.skeletons') {
            continue;
        }
        
        // Filtrer par workspace
        const metadataPath = path.join(tasksDir, convDir.name, 'task_metadata.json');
        try {
            const metadataContent = await fs.readFile(metadataPath, 'utf-8');
            const metadata = JSON.parse(metadataContent);
            const taskWorkspace = metadata.workspace || metadata.cwd || '';
            
            const normalizedFilter = path.normalize(TARGET_WORKSPACE).toLowerCase();
            const normalizedWorkspace = path.normalize(taskWorkspace).toLowerCase();
            
            if (!normalizedWorkspace.includes(normalizedFilter)) {
                continue;
            }
            
            // Analyser cette tâche
            const taskPath = path.join(tasksDir, convDir.name);
            const skeleton = await RooStorageDetector.analyzeConversation(convDir.name, taskPath);
            
            if (skeleton && skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0) {
                console.log('='.repeat(80));
                console.log(`✅ Task: ${convDir.name}`);
                console.log(`   Prefixes found: ${skeleton.childTaskInstructionPrefixes.length}`);
                skeleton.childTaskInstructionPrefixes.forEach((prefix, idx) => {
                    console.log(`   [${idx + 1}] ${prefix.substring(0, 100)}${prefix.length > 100 ? '...' : ''}`);
                });
                tested++;
                
                if (tested >= 5) {
                    break;
                }
            }
            
        } catch (error) {
            // Skip tasks with errors
        }
    }
    
    if (tested === 0) {
        console.log('⚠️  No tasks with prefixes found');
    } else {
        console.log('\n' + '='.repeat(80));
        console.log(`Tested ${tested} tasks with prefixes`);
    }
}

main().catch(console.error);