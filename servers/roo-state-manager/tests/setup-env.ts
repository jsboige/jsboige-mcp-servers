// Node 18+ has native fetch - no polyfill needed
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger .env.test en priorité (ne surcharge pas si déjà défini)
dotenv.config({ path: path.join(__dirname, '..', '.env.test') });
// Charger .env pour les clés manquantes (ex: API keys)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// GLOBAL SAFETY GUARD: Redirect APPDATA to a temp directory for ALL tests.
// This prevents any test from accidentally reading/writing the real
// mcp_settings.json (incident 2026-03-08 on ai-01, 2026-03-10 on po-2026).
// See: commit ce7d4abd, issue #629 comments.
const testAppData = path.join(os.tmpdir(), '__roo-state-manager-test-appdata__');
const testMcpDir = path.join(testAppData, 'Code', 'User', 'globalStorage',
  'rooveterinaryinc.roo-cline', 'settings');
if (!fs.existsSync(testMcpDir)) {
  fs.mkdirSync(testMcpDir, { recursive: true });
}
// Write a sentinel mcp_settings.json so tests that read it don't crash
const sentinelPath = path.join(testMcpDir, 'mcp_settings.json');
if (!fs.existsSync(sentinelPath)) {
  fs.writeFileSync(sentinelPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8');
}
// Only override if not already set by a specific test's vi.hoisted()
if (!process.env.APPDATA?.includes('__test-data__')) {
  process.env.APPDATA = testAppData;
}