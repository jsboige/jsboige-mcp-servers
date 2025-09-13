import { describe, it, expect } from '@jest/globals';
import { RooStateManagerServer } from '../src/index.js';
import packageJson from '../package.json' with { type: 'json' };
describe('Server Versioning', () => {
    it('should load the version from package.json', () => {
        const server = new RooStateManagerServer();
        // @ts-ignore - Accéder à la propriété privée pour le test
        const serverInstance = server['server'];
        // @ts-ignore - Accéder à la propriété privée pour le test
        expect(serverInstance.options.info.version).toBe(packageJson.version);
    });
});
//# sourceMappingURL=versioning.test.js.map