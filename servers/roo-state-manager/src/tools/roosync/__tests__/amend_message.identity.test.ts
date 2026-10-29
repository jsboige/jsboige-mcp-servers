/**
 * Régression d'identité — amend_message (#4149 F2, phase 0).
 *
 * `amend_message` avait sa PROPRE copie du helper d'identité, qui lisait
 * `ROOSYNC_MACHINE_ID` sans normalisation ; la phase 0 l'a ramené sur le
 * helper partagé, qui normalise l'identifiant machine en minuscule comme
 * partout ailleurs dans le dépôt.
 *
 * Cet écart de comportement en mode **stdio** est assumé (une seule sémantique
 * d'identité dans le dépôt) mais doit être **épinglé** : c'est le seul
 * changement observable côté stdio de cette PR. Le test verrouille donc la
 * forme normalisée, et le corps de la PR le déclare explicitement au lieu de
 * revendiquer « zéro changement en mode stdio ».
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockAmendMessage } = vi.hoisted(() => ({
	mockAmendMessage: vi.fn(),
}));

vi.mock('../../../services/MessageManager.js', () => ({
	MessageManager: class {
		constructor() {}
		amendMessage(...args: any[]) {
			return mockAmendMessage(...args);
		}
	},
	getMessageManager: () => ({
		amendMessage: (...args: any[]) => mockAmendMessage(...args),
	}),
}));

vi.mock('../../../utils/server-helpers.js', () => ({
	getSharedStatePath: () => 'C:/tmp/rsm-test',
}));

import { amendMessage } from '../amend_message.js';

const savedMachine = process.env.ROOSYNC_MACHINE_ID;
const savedWorkspace = process.env.ROOSYNC_WORKSPACE_ID;

describe('amend_message — identité machine normalisée (régression #4149 F2)', () => {
	beforeEach(() => {
		mockAmendMessage.mockReset();
		mockAmendMessage.mockResolvedValue({
			message_id: 'msg-1',
			amended_at: '2026-01-01T00:00:00Z',
			reason: 'test',
			original_content_preserved: true,
		});
	});

	afterEach(() => {
		if (savedMachine === undefined) delete process.env.ROOSYNC_MACHINE_ID;
		else process.env.ROOSYNC_MACHINE_ID = savedMachine;
		if (savedWorkspace === undefined) delete process.env.ROOSYNC_WORKSPACE_ID;
		else process.env.ROOSYNC_WORKSPACE_ID = savedWorkspace;
	});

	test('normalise l\'identifiant machine de l\'env en minuscule', async () => {
		process.env.ROOSYNC_MACHINE_ID = 'ENV-Machine';
		process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';

		await amendMessage({ message_id: 'msg-1', new_content: 'contenu' });

		expect(mockAmendMessage).toHaveBeenCalledWith(
			'msg-1',
			'env-machine:roo-extensions',
			'contenu',
			undefined,
		);
	});

	test('laisse un identifiant machine déjà minuscule inchangé', async () => {
		process.env.ROOSYNC_MACHINE_ID = 'myia-web2';
		process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';

		await amendMessage({ message_id: 'msg-2', new_content: 'contenu' });

		expect(mockAmendMessage).toHaveBeenCalledWith(
			'msg-2',
			'myia-web2:roo-extensions',
			'contenu',
			undefined,
		);
	});
});
