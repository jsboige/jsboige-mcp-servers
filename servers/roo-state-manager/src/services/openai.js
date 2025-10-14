import OpenAI from 'openai';
import { config } from 'dotenv';

// Charger les variables d'environnement
config();

let openaiClient = null;

/**
 * Singleton pour le client OpenAI
 * Configure automatiquement le client avec la clé API depuis .env
 * @returns {OpenAI} Instance configurée du client OpenAI
 */
export default function getOpenAIClient() {
    if (openaiClient === null) {
        const apiKey = process.env.OPENAI_API_KEY;
        
        if (!apiKey) {
            throw new Error('OPENAI_API_KEY manquant dans les variables d\'environnement');
        }
        
        openaiClient = new OpenAI({
            apiKey: apiKey
        });
        
        console.log('✅ Client OpenAI initialisé avec succès');
    }
    
    return openaiClient;
}