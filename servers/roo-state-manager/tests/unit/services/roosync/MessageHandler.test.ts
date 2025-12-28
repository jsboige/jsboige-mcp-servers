import { describe, it, expect } from 'vitest';
import { MessageHandler } from '../../../../src/services/roosync/MessageHandler.js';
import { RooSyncConfig } from '../../../../src/config/roosync-config.js';

describe('MessageHandler', () => {
    const mockConfig = {
        machineId: 'test-machine',
        sharedPath: '/tmp/shared'
    } as RooSyncConfig;

    const messageHandler = new MessageHandler(mockConfig);

    describe('parseLogs', () => {
        it('should parse logs from output string', () => {
            const output = `
                Log line 1
                Log line 2
                
                Log line 3
            `;
            const logs = messageHandler.parseLogs(output);
            expect(logs).toEqual(['Log line 1', 'Log line 2', 'Log line 3']);
        });

        it('should return empty array for empty output', () => {
            const logs = messageHandler.parseLogs('');
            expect(logs).toEqual([]);
        });
    });

    describe('parseChanges', () => {
        it('should detect modified files', () => {
            const output = 'Configuration de référence mise à jour avec succès';
            const changes = messageHandler.parseChanges(output);
            expect(changes.filesModified).toContain('sync-config.ref.json');
        });

        it('should return empty changes if no patterns match', () => {
            const output = 'Some random output';
            const changes = messageHandler.parseChanges(output);
            expect(changes.filesModified).toEqual([]);
            expect(changes.filesCreated).toEqual([]);
            expect(changes.filesDeleted).toEqual([]);
        });
    });
});