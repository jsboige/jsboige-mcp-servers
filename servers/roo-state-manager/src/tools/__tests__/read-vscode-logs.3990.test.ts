/**
 * Tests #3990 — robustesse de read_vscode_logs.
 *
 * Trois défauts vivaient dans le même fichier :
 *   1. ReDoS : `filter` compilé et appliqué à chaque ligne sans borne ;
 *   2. OOM  : `fs.readFile` chargeait le fichier entier même pour `lines: 10` ;
 *   4. erreurs avalées : readdir en échec et regex invalide étaient muets, et
 *      l'appelant lisait « No relevant VS Code logs found » — un faux négatif.
 * (Le défaut 3, params non validés, a été fermé par #4002.)
 *
 * Scaffold calqué sur read-vscode-logs.test.ts (fs/promises mocké), avec `open`
 * en plus pour couvrir la lecture bornée des gros fichiers.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockReaddir, mockReadFile, mockAccess, mockStat, mockOpen } = vi.hoisted(() => ({
	mockReaddir: vi.fn(),
	mockReadFile: vi.fn(),
	mockAccess: vi.fn(),
	mockStat: vi.fn(),
	mockOpen: vi.fn()
}));

vi.mock('fs/promises', () => ({
	default: {
		readdir: mockReaddir,
		readFile: mockReadFile,
		access: mockAccess,
		stat: mockStat,
		open: mockOpen
	},
	readdir: mockReaddir,
	readFile: mockReadFile,
	access: mockAccess,
	stat: mockStat,
	open: mockOpen
}));

/** One session, one window, and only renderer.log present. */
function setupSingleWindow(rendererContent: string | Error) {
	mockReaddir.mockResolvedValueOnce([{ name: '20260215T100000', isDirectory: () => true }]);
	mockReaddir.mockResolvedValueOnce([{ name: 'window1', isDirectory: () => true }]);
	mockAccess.mockResolvedValueOnce(undefined);                    // renderer.log exists
	if (rendererContent instanceof Error) {
		mockReadFile.mockRejectedValueOnce(rendererContent);
	} else {
		mockReadFile.mockResolvedValueOnce(rendererContent);
	}
	mockAccess.mockRejectedValueOnce(new Error('ENOENT'));           // exthost.log
	mockAccess.mockRejectedValueOnce(new Error('ENOENT'));           // main.log
	mockAccess.mockRejectedValueOnce(new Error('ENOENT'));           // nested exthost
	mockReaddir.mockResolvedValueOnce([]);                           // exthost output dirs
}

describe('read_vscode_logs — robustesse (#3990)', () => {
	const origAppdata = process.env.APPDATA;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
	});

	afterEach(() => {
		process.env.APPDATA = origAppdata;
	});

	// ---------------------------------------------------------------
	// Défaut 1 — ReDoS
	// ---------------------------------------------------------------

	test('refuse un filter au-delà de la borne, sans toucher au disque', async () => {
		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({ filter: 'a'.repeat(201) });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/over the 200-character limit/);
		// Fail-loud AVANT toute lecture : le refus ne coûte pas un scan de logs.
		expect(mockReaddir).not.toHaveBeenCalled();
		expect(mockReadFile).not.toHaveBeenCalled();
	});

	test('accepte un filter exactement à la borne', async () => {
		setupSingleWindow('ligne avec ' + 'b'.repeat(200));

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({ filter: 'b'.repeat(200) });

		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain('b'.repeat(200));
	});

	test('bascule en littéral annoncé sur un motif à quantificateur imbriqué', async () => {
		// `aaa` matcherait la regex `(a+)+` ; en littéral il ne matche pas.
		setupSingleWindow('aaa\nliteral (a+)+ ici');

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({ filter: '(a+)+' });

		const text = result.content[0].text;
		expect(text).toContain('literal (a+)+ ici');
		expect(text).not.toContain('aaa');
		// La dégradation est DITE, jamais silencieuse (défaut 4).
		expect(text).toContain('--- WARNINGS (1) ---');
		expect(text).toContain('catastrophic-backtracking');
	});

	test('bascule en littéral annoncé sur une regex invalide', async () => {
		setupSingleWindow('[unclosed line\nautre ligne');

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({ filter: '[unclosed' });

		const text = result.content[0].text;
		expect(text).toContain('[unclosed line');
		expect(text).not.toContain('autre ligne');
		expect(text).toContain('not a valid regular expression');
	});

	test('ne signale rien sur un filtre légitime (pas de bruit)', async () => {
		setupSingleWindow('[WARN] un\n[ERROR] deux');

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({ filter: '\\[WARN\\]|\\[ERROR\\]' });

		const text = result.content[0].text;
		expect(text).toContain('[WARN] un');
		expect(text).toContain('[ERROR] deux');
		expect(text).not.toContain('--- WARNINGS');
	});

	// ---------------------------------------------------------------
	// Défaut 2 — OOM
	// ---------------------------------------------------------------

	test('lit la queue par fenêtre bornée sur un gros fichier, et le dit', async () => {
		const TWENTY_MB = 20 * 1024 * 1024;
		mockStat.mockResolvedValue({ size: TWENTY_MB });
		// La fenêtre s'ouvre au milieu du fichier : sa 1re ligne est coupée.
		const TAIL = 'LIGNE-COUPEE-AMORCE\nline-A\nline-B\nline-C';
		mockOpen.mockResolvedValue({
			read: async (buf: Buffer, _offset: number, length: number) => {
				const chunk = Buffer.from(TAIL, 'utf-8');
				const n = Math.min(chunk.length, length);
				chunk.copy(buf, 0, 0, n);
				return { bytesRead: n, buffer: buf };
			},
			close: async () => { /* no-op */ }
		});
		setupSingleWindow('peu importe — readFile ne doit PAS être appelé');

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({ lines: 2 });

		const text = result.content[0].text;
		// readFile est le chemin OOM : il ne doit pas être emprunté ici.
		expect(mockReadFile).not.toHaveBeenCalled();
		expect(mockOpen).toHaveBeenCalledTimes(1);
		// La ligne d'amorce tronquée est jetée, la queue est conservée.
		expect(text).not.toContain('LIGNE-COUPEE-AMORCE');
		expect(text).toContain('line-C');
		expect(text).toContain('line-B');
		// Une recherche partielle doit être VISIBLE (défaut 4).
		expect(text).toContain('only the last 2 MB were searched');
		expect(text).toContain('--- WARNINGS');
	});

	test('garde la lecture entière sous le seuil (comportement inchangé)', async () => {
		mockStat.mockResolvedValue({ size: 1024 });
		setupSingleWindow('petit contenu');

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({ lines: 10 });

		expect(mockOpen).not.toHaveBeenCalled();
		expect(mockReadFile).toHaveBeenCalled();
		expect(result.content[0].text).toContain('petit contenu');
	});

	// ---------------------------------------------------------------
	// Défaut 4 — erreurs avalées
	// ---------------------------------------------------------------

	test("une lecture en échec devient un avertissement, pas du faux contenu", async () => {
		setupSingleWindow(new Error('EBUSY: resource busy'));

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({ lines: 10 });

		const text = result.content[0].text;
		// L'ancien code rendait « Error reading <path>: … » COMME du contenu de log.
		expect(text).not.toContain('Error reading');
		expect(text).toContain('could not read');
		expect(text).toContain('EBUSY');
		expect(text).toContain('--- WARNINGS');
	});

	test("un readdir en échec n'est plus un faux « no logs found » muet", async () => {
		mockReaddir.mockResolvedValueOnce([{ name: '20260215T100000', isDirectory: () => true }]);
		mockReaddir.mockRejectedValueOnce(new Error('EACCES: permission denied'));

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({});

		const text = result.content[0].text;
		expect(text).toContain('No relevant VS Code logs found');
		// …mais la cause est nommée : le lecteur ne peut plus la prendre pour un vide réel.
		expect(text).toContain('could not list');
		expect(text).toContain('EACCES');
		expect(text).toContain('--- WARNINGS (1) ---');
	});
});
