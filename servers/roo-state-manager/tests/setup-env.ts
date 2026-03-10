// Node 18+ has native fetch - no polyfill needed
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger .env.test en priorité (ne surcharge pas si déjà défini)
dotenv.config({ path: path.join(__dirname, '..', '.env.test') });
// Charger .env pour les clés manquantes (ex: API keys)
dotenv.config({ path: path.join(__dirname, '..', '.env') });