import { Tool } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

interface DiagnoseEnvOptions {
    checkDiskSpace?: boolean;
}

export const diagnose_env: Tool = {
    name: 'diagnose_env',
    description: 'Vérifie la santé de l\'environnement d\'exécution (Versions, Accès Fichiers, Ressources).',
    inputSchema: {
        type: 'object',
        properties: {
            checkDiskSpace: {
                type: 'boolean',
                description: 'Vérifier l\'espace disque (peut être lent sur certains systèmes)'
            }
        }
    },
};

export async function diagnoseEnv(options: DiagnoseEnvOptions = {}) {
    const report: any = {
        timestamp: new Date().toISOString(),
        system: {
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            hostname: os.hostname(),
            uptime: os.uptime(),
            totalMemory: os.totalmem(),
            freeMemory: os.freemem()
        },
        directories: {},
        envVars: {
            // Check only safe/relevant env vars
            hasPath: !!process.env.PATH,
            cwd: process.cwd()
        },
        status: 'OK'
    };

    const criticalDirs = [
        '.',
        '.shared-state',
        'roo-config',
        'mcps',
        'logs'
    ];

    for (const dir of criticalDirs) {
        const fullPath = path.resolve(process.cwd(), dir);
        try {
            await fs.access(fullPath, fs.constants.R_OK | fs.constants.W_OK);
            report.directories[dir] = { exists: true, writable: true };
        } catch (err: any) {
            report.directories[dir] = { exists: false, error: err.code };
            report.status = 'WARNING'; // Downgrade status if a dir is missing/unwritable
        }
    }

    // Check for critical files presence
    const criticalFiles = [
        'package.json',
        'tsconfig.json'
    ];

    for (const file of criticalFiles) {
        try {
            await fs.access(path.resolve(process.cwd(), file));
        } catch {
             report.status = 'WARNING';
             report.missingFiles = report.missingFiles || [];
             report.missingFiles.push(file);
        }
    }

    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify(report, null, 2)
        }]
    };
}