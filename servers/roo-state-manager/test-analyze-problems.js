import { analyzeRooSyncProblems } from './build/tools/diagnostic/analyze_problems.js';

// Test de l'outil analyze_roosync_problems
console.log('Test de l\'outil analyze_roosync_problems...');
console.log('ROOSYNC_SHARED_PATH:', process.env.ROOSYNC_SHARED_PATH);

analyzeRooSyncProblems({}).then(result => {
    console.log('Résultat:', JSON.stringify(result, null, 2));
}).catch(error => {
    console.error('Erreur:', error);
});
