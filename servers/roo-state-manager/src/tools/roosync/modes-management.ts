/**
 * Modes Management - Gestion des modes Roo globaux (custom_modes.yaml)
 *
 * Lecture, mise a jour de champs, et comparaison des modes.
 * Ce module N'EST PAS enregistre comme outil MCP autonome.
 * Il sera integre dans le mecanisme de config unifie (#603).
 *
 * @module tools/roosync/modes-management
 * @version 2.0.0
 * @issue #595, #603
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

// ====================================================================
// TYPES
// ====================================================================

export interface RooMode {
    slug: string;
    name: string;
    roleDefinition?: string;
    description?: string;
    whenToUse?: string;
    customInstructions?: string;
    groups?: string[];
    source?: string;
}

export interface CustomModesData {
    customModes: RooMode[];
}

export interface ModesSummary {
    slug: string;
    name: string;
    groups: string[];
    hasCustomInstructions: boolean;
    hasRoleDefinition: boolean;
}

// ====================================================================
// PATHS
// ====================================================================

/**
 * Returns the path to custom_modes.yaml on the current machine.
 * Windows: %APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/custom_modes.yaml
 */
export function getCustomModesPath(): string {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(
        appdata,
        'Code', 'User', 'globalStorage',
        'rooveterinaryinc.roo-cline', 'settings',
        'custom_modes.yaml'
    );
}

// ====================================================================
// READ
// ====================================================================

/**
 * Read and parse custom_modes.yaml using js-yaml.
 * Returns null if the file does not exist.
 */
export async function readCustomModes(filePath?: string): Promise<CustomModesData | null> {
    const targetPath = filePath || getCustomModesPath();
    try {
        const content = await fs.readFile(targetPath, 'utf-8');
        const data = yaml.load(content) as CustomModesData;
        if (!data || !Array.isArray(data.customModes)) {
            throw new Error('Invalid custom_modes.yaml: missing customModes array');
        }
        return data;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

/**
 * Returns a lightweight summary of all modes (no large text fields).
 */
export async function listModesSummary(filePath?: string): Promise<ModesSummary[]> {
    const data = await readCustomModes(filePath);
    if (!data) return [];

    return data.customModes.map(m => ({
        slug: m.slug,
        name: m.name,
        groups: m.groups || [],
        hasCustomInstructions: !!m.customInstructions,
        hasRoleDefinition: !!m.roleDefinition,
    }));
}

// ====================================================================
// WRITE
// ====================================================================

/**
 * Backup custom_modes.yaml before modification.
 * Returns the backup file path.
 */
export async function backupCustomModes(filePath?: string): Promise<string> {
    const targetPath = filePath || getCustomModesPath();
    const content = await fs.readFile(targetPath, 'utf-8');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = path.join(path.dirname(targetPath), 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `custom_modes.${timestamp}.yaml`);
    await fs.writeFile(backupPath, content, 'utf-8');
    return backupPath;
}

/**
 * Write custom_modes.yaml back using js-yaml.dump for proper YAML formatting
 * (multi-line block scalars, correct indentation).
 */
export async function writeCustomModes(data: CustomModesData, filePath?: string): Promise<void> {
    const targetPath = filePath || getCustomModesPath();
    const output = yaml.dump(data, {
        lineWidth: -1,       // No line wrapping (preserve long strings)
        noRefs: true,        // No YAML anchors/aliases
        quotingType: '"',    // Use double quotes when quoting
        forceQuotes: false,  // Only quote when necessary
        sortKeys: false,     // Preserve key order
    });
    await fs.writeFile(targetPath, output, 'utf-8');
}

/**
 * Update a single field of a mode identified by slug.
 * Creates a backup before modification.
 */
export async function updateModeField(
    slug: string,
    field: keyof RooMode,
    value: unknown,
    filePath?: string
): Promise<{ backupPath: string; previousValue: unknown }> {
    const targetPath = filePath || getCustomModesPath();
    const data = await readCustomModes(targetPath);
    if (!data) {
        throw new Error(`custom_modes.yaml not found at ${targetPath}`);
    }

    const mode = data.customModes.find(m => m.slug === slug);
    if (!mode) {
        const available = data.customModes.map(m => m.slug).join(', ');
        throw new Error(`Mode "${slug}" not found. Available: ${available}`);
    }

    const backupPath = await backupCustomModes(targetPath);
    const previousValue = (mode as unknown as Record<string, unknown>)[field];
    (mode as unknown as Record<string, unknown>)[field] = value;

    await writeCustomModes(data, targetPath);
    return { backupPath, previousValue };
}

// ====================================================================
// COMPARE
// ====================================================================

export interface ModesDiff {
    slug: string;
    name: string;
    differences: {
        field: string;
        localValue: unknown;
        remoteValue: unknown;
    }[];
}

export interface ModesComparison {
    localOnly: string[];
    remoteOnly: string[];
    common: string[];
    diffs: ModesDiff[];
}

/**
 * Compare local modes with a remote modes dataset.
 * Used for cross-machine comparison via RooSync shared-state.
 */
export function compareModes(local: CustomModesData, remote: CustomModesData): ModesComparison {
    const localSlugs = new Set(local.customModes.map(m => m.slug));
    const remoteSlugs = new Set(remote.customModes.map(m => m.slug));

    const localOnly = Array.from(localSlugs).filter(s => !remoteSlugs.has(s));
    const remoteOnly = Array.from(remoteSlugs).filter(s => !localSlugs.has(s));
    const common = Array.from(localSlugs).filter(s => remoteSlugs.has(s));

    const fieldsToCompare: (keyof RooMode)[] = ['name', 'groups', 'roleDefinition', 'customInstructions', 'description', 'whenToUse'];

    const diffs: ModesDiff[] = [];
    for (const slug of common) {
        const localMode = local.customModes.find(m => m.slug === slug)!;
        const remoteMode = remote.customModes.find(m => m.slug === slug)!;

        const differences: ModesDiff['differences'] = [];
        for (const field of fieldsToCompare) {
            const lv = localMode[field];
            const rv = remoteMode[field];
            if (JSON.stringify(lv) !== JSON.stringify(rv)) {
                differences.push({ field, localValue: lv, remoteValue: rv });
            }
        }

        if (differences.length > 0) {
            diffs.push({ slug, name: localMode.name, differences });
        }
    }

    return { localOnly, remoteOnly, common, diffs };
}

// ====================================================================
// NOTE: Ce module est une API INTERNE uniquement.
// Il ne doit PAS être enregistré comme outil MCP séparé.
// La gestion des modes sera intégrée dans le mécanisme unifié de config (#603).
// #595 est subsumé par #603.
//
// Usage interne:
//   import { readCustomModes, compareModes, listModesSummary } from './modes-management.js';
// ====================================================================
