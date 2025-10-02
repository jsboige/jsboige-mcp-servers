/**
 * Script de démonstration du refactoring des strategies de reporting
 * Teste la nouvelle architecture avec formatMessageContent() au lieu de shouldInclude()
 */

import { DetailLevelStrategyFactory } from './services/reporting/DetailLevelStrategyFactory.js';

// Données de test simulant du contenu classifié
const mockClassifiedContent = [
    {
        type: 'User',
        subType: 'UserMessage', 
        content: 'Créer une nouvelle fonctionnalité pour l\'application',
        index: 0,
        contentSize: 45,
        isRelevant: true,
        confidenceScore: 1.0
    },
    {
        type: 'Assistant',
        subType: 'ToolCall',
        content: '<write_to_file><path>app.js</path><content>console.log("Hello");