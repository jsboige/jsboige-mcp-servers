/**
 * Prototype pour #509 - Collecte des settings de condensation Roo
 *
 * Structure découverte dans state.vscdb:
 * - Table: ItemTable
 * - Key: 'RooVeterinaryInc.roo-cline'
 * - JSON fields:
 *   - autoCondenseContext: boolean
 *   - autoCondenseContextPercent: number (global threshold)
 *   - profileThresholds: Record<profileId, threshold>
 *
 * @version 0.1.0 - Prototype d'investigation
 */

import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';

interface CondensationSettings {
	enabled: boolean;
	globalThreshold: number;
	profileThresholds: Record<string, { name: string; threshold: number }>;
}

interface ApiConfigMeta {
	id: string;
	name: string;
	apiProvider: string;
}

interface RooGlobalState {
	autoCondenseContext?: boolean;
	autoCondenseContextPercent?: number;
	profileThresholds?: Record<string, number>;
	listApiConfigMeta?: ApiConfigMeta[];
	[key: string]: unknown;
}

/**
 * Chemin vers state.vscdb
 */
function getStateDbPath(): string {
	return path.join(
		os.homedir(),
		'AppData',
		'Roaming',
		'Code',
		'User',
		'globalStorage',
		'state.vscdb'
	);
}

/**
 * Ouvre la base de données SQLite
 */
async function openDatabase(filePath: string): Promise<sqlite3.Database> {
	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (err) => {
			if (err) {
				reject(new Error(`Impossible d'ouvrir state.vscdb: ${err.message}`));
			} else {
				resolve(db);
			}
		});
	});
}

/**
 * Ferme la base de données
 */
async function closeDatabase(db: sqlite3.Database): Promise<void> {
	return new Promise((resolve, reject) => {
		db.close((err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

/**
 * Collecte les settings de condensation depuis state.vscdb
 */
export async function collectCondensationSettings(): Promise<CondensationSettings> {
	const dbPath = getStateDbPath();

	// Vérifier que le fichier existe
	try {
		await fs.access(dbPath);
	} catch {
		throw new Error(`state.vscdb non trouvé: ${dbPath}`);
	}

	const db = await openDatabase(dbPath);

	try {
		const get = promisify(db.get.bind(db)) as (
			sql: string,
			params?: unknown[]
		) => Promise<{ value: string } | undefined>;

		// Lire la clé RooVeterinaryInc.roo-cline
		const row = await get(
			"SELECT value FROM ItemTable WHERE key = 'RooVeterinaryInc.roo-cline'"
		);

		if (!row) {
			throw new Error('Clé RooVeterinaryInc.roo-cline non trouvée dans state.vscdb');
		}

		const state: RooGlobalState = JSON.parse(row.value);

		// Extraire les settings de condensation
		const enabled = state.autoCondenseContext ?? false;
		const globalThreshold = state.autoCondenseContextPercent ?? 50;
		const rawProfileThresholds = state.profileThresholds ?? {};

		// Mapper les IDs de profil aux noms
		const profileConfigs = state.listApiConfigMeta ?? [];
		const profileThresholds: Record<string, { name: string; threshold: number }> = {};

		for (const [profileId, threshold] of Object.entries(rawProfileThresholds)) {
			const config = profileConfigs.find((c) => c.id === profileId);
			profileThresholds[profileId] = {
				name: config?.name ?? `unknown-${profileId}`,
				threshold: threshold as number
			};
		}

		return {
			enabled,
			globalThreshold,
			profileThresholds
		};
	} finally {
		await closeDatabase(db);
	}
}

/**
 * Test du prototype
 */
async function main(): Promise<void> {
	console.log('=== #509 Prototype - Collecte Condensation Settings ===\n');

	try {
		const settings = await collectCondensationSettings();

		console.log('Settings de condensation collectés:');
		console.log(JSON.stringify(settings, null, 2));

		console.log('\n=== Résumé ===');
		console.log(`Condensation activée: ${settings.enabled}`);
		console.log(`Seuil global: ${settings.globalThreshold}%`);
		console.log(`Profils configurés: ${Object.keys(settings.profileThresholds).length}`);

		for (const [id, data] of Object.entries(settings.profileThresholds)) {
			console.log(`  - ${data.name} (${id}): ${data.threshold}%`);
		}
	} catch (error) {
		console.error('Erreur:', error);
		process.exit(1);
	}
}

// Exécuter le test si appelé directement
if (process.argv[1]?.includes('condensation-settings-collect.prototype')) {
	main();
}
