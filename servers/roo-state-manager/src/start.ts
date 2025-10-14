import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Configurer dotenv le plus tôt possible
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

// Maintenant, importer et lancer le serveur
// L'importation se fait après que les variables d'environnement soient chargées
import('./index.js').catch(err => {
    console.error("Failed to start server:", err);
    process.exit(1);
});