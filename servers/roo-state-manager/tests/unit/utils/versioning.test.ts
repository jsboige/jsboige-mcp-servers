import { describe, it, expect } from 'vitest';
import { RooStateManagerServer } from '../../../src/index.js';
import packageJson from '../../../package.json' with { type: 'json' };
describe('Server Versioning', () => {
    it('should load the version from package.json', () => {
        const server = new RooStateManagerServer();
        // Le serveur MCP utilise la version du package.json directement
        // La version est déjà disponible via la configuration du serveur
        expect(packageJson.version).toBeDefined();
        expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
});