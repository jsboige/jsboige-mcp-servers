import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM-safe way to get __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from the parent directory (project root)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });