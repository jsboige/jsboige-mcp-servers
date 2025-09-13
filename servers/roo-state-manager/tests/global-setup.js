import dotenv from 'dotenv';
import path from 'path';
/**
 * @file global-setup.ts
 * @description Ce script est exécuté une seule fois avant la suite de tests Jest.
 * Son rôle principal est de s'assurer que les services externes, comme Qdrant,
 * sont entièrement démarrés et prêts à accepter des connexions avant que les tests ne commencent.
 *
 * Pourquoi ce fichier est-il nécessaire ?
 * Dans un environnement basé sur Docker, les conteneurs peuvent prendre quelques secondes pour démarrer.
 * Si les tests s'exécutent immédiatement, ils peuvent échouer avec des erreurs de connexion
 * (comme ECONNREFUSED) parce que le service n'est pas encore prêt. Ce script implémente
 * un mécanisme de "wait-for-it" qui sonde le service à intervalles réguliers jusqu'à ce qu'il
 * soit disponible, résolvant ainsi cette "race condition".
 */
const MAX_RETRIES = 15;
const RETRY_DELAY = 2000; // en millisecondes
/**
 * Attend que le service Qdrant soit disponible.
 *
 * @param {string} url - L'URL de Qdrant à sonder.
 * @returns {Promise<void>} Une promesse qui se résout lorsque Qdrant est prêt.
 * @throws {Error} Si Qdrant n'est pas disponible après le nombre maximum de tentatives.
 */
const waitForQdrant = async (url) => {
    console.log('--- Global Setup: Waiting for Qdrant to be ready...');
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            // On utilise l'endpoint /readyz qui est fait pour les health checks
            const response = await fetch(new URL('/readyz', url).toString());
            if (response.ok) {
                console.log('✅ Qdrant is ready!');
                return;
            }
        }
        catch (error) {
            if (error.cause && error.cause.code === 'ECONNREFUSED') {
                console.log(`Attempt ${i + 1}/${MAX_RETRIES}: Qdrant not ready yet (ECONNREFUSED). Retrying in ${RETRY_DELAY / 1000}s...`);
            }
            else {
                console.log(`Attempt ${i + 1}/${MAX_RETRIES}: An unexpected error occurred: ${error.message}. Retrying in ${RETRY_DELAY / 1000}s...`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
    throw new Error(`❌ Qdrant service was not ready at ${url} after ${MAX_RETRIES} attempts.`);
};
/**
 * Configuration globale pour Jest.
 * Charge les variables d'environnement et attend que Qdrant soit prêt.
 */
import { startProxy } from './e2e/proxy.js';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROXY_PORT = 3001;
export default async () => {
    // Charger les variables d'environnement à partir du fichier .env.test
    dotenv.config({ path: path.resolve(__dirname, '..', '.env.test') });
    const qdrantUrl = process.env.QDRANT_URL;
    if (!qdrantUrl) {
        throw new Error('QDRANT_URL is not defined in the environment variables.');
    }
    // Démarrer le proxy
    const proxyServer = await startProxy(qdrantUrl, PROXY_PORT);
    global.__PROXY__ = proxyServer;
    // Mettre à jour QDRANT_URL pour pointer vers le proxy pour les tests
    process.env.QDRANT_URL = `http://localhost:${PROXY_PORT}`;
    // Attendre que le VRAI service Qdrant soit prêt avant de continuer
    await waitForQdrant(qdrantUrl);
};
//# sourceMappingURL=global-setup.js.map