const dotenv = require('dotenv');
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Configurer dotenv le plus tôt possible
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({
    path: join(__dirname, '..', '.env')
});

// 🔇 REDIRECTER CONSOLE.LOG VERS STDERR POUR MCP
// Les messages MCP doivent aller sur stdout uniquement, les logs de debug sur stderr
if (!process.env.ROO_DEBUG_LOGS) {
    const originalLog = console.log;
    console.log = (...args: any[]) => {
        // Filtrer les logs de debug et les envoyer sur stderr
        const message = args.join(' ');
        if (message.includes('[DEBUG]') ||
            message.includes('[Auto-Repair]') ||
            message.includes('🔧') ||
            message.includes('⚙️') ||
            message.includes('✅') && !message.includes('Server started') ||
            message.includes('🔍') && !message.includes('Machine actuelle') ||
            message.includes('📊') ||
            message.includes('⚠️')) {
            console.error(...args);  // Envoyer sur stderr au lieu de stdout
        } else if (message.includes('Server started')) {
            originalLog(...args);  // Garder le message de démarrage sur stdout
        }
    };
}

// Maintenant, importer et lancer le serveur
// L'importation se fait après que les variables d'environnement soient chargées
import('./index.js').catch(err => {
    console.error("Failed to start server:", err);
    process.exit(1);
});