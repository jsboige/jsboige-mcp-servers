/**
 * Complétude de la surface du gate HTTP — #4149 F2.
 *
 * Revue ai-01 du 29/10 (bloquant 1) : « une écriture sans identité ne doit
 * pas pouvoir se cacher dans un outil non classifié ». Ce test compare la
 * classification du transport à la surface RÉELLE du registre
 * (`src/tools/registry.ts`) :
 *
 * 1. tout outil dispatché par le registre est classifié (lecture seule,
 *    mixte, ou écriture) — un outil ajouté demain fait ÉCHOUER ce test tant
 *    qu'il n'est pas conscientement classé ;
 * 2. aucun outil n'est dans deux catégories à la fois ;
 * 3. aucune action mutante connue ne figure dans un ensemble d'actions de
 *    lecture.
 *
 * Le test est volontairement **fail-closed** : si le registre n'est pas
 * lisible ou si le parsing ne trouve rien, il échoue — un instrument muet
 * ne vaut pas un garde.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CLASSIFIED_TOOLS, classifyCall } from '../http-transport.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(HERE, '..', '..', 'tools', 'registry.ts');

/** Noms d'outils réellement dispatchés par le registre. */
function registryToolNames(): string[] {
    const source = readFileSync(REGISTRY_PATH, 'utf-8');
    const names = new Set<string>();
    const re = /case\s+'([a-z_0-9]+)'\s*:/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        names.add(match[1]);
    }
    return [...names].sort();
}

/** Actions jamais autorisées en lecture (verbe mutateur connu du dépôt). */
const MUTATING_ACTIONS = new Set([
    'write', 'append', 'update', 'delete', 'merge', 'scrub',
    'send', 'reply', 'amend', 'mark_read', 'archive',
    'bulk_mark_read', 'bulk_archive', 'cleanup', 'attachments_delete',
    'create', 'dispatch', 'remind', 'apply', 'apply_profile', 'publish',
    'restore', 'repair', 'repair_gaps', 'repair_workspace', 'rebuild',
    'reset', 'index', 'index_code_supplement', 'install', 'set', 'remove',
    'save', 'save_snapshot', 'init', 'touch', 'maintenance', 'confirm',
    'close', 'lifecycle', 'recovery', 'reload', 'execute', 'run', 'import',
    'download', 'upload', 'load', 'garbage_scan', 'cleanup_orphans',
    'cleanup_failed', 'version',
    // roosync_claim écrit active-claims.json (claims/claim.tool.ts:52) —
    // revue ms#1578, défaut 1 : l'outil était classé pure-read EN BLOC.
    'claim', 'release', 'extend',
    // revue ms#1578, bloquant 2 : `refresh` régénère des fichiers dans le
    // store partagé, `export` écrit un fichier au chemin de l'appelant.
    'refresh', 'export',
]);

describe('#4149 F2 — complétude de la surface du gate HTTP', () => {
    it('le registre est lisible et contient bien des tools', () => {
        const names = registryToolNames();
        expect(names.length).toBeGreaterThan(40);
        expect(names).toContain('roosync_dashboard');
        expect(names).toContain('roosync_messages');
    });

    it('tout outil dispatché par le registre est classifié', () => {
        const classified = new Set<string>([
            ...CLASSIFIED_TOOLS.readOnly,
            ...Object.keys(CLASSIFIED_TOOLS.mixed),
            ...CLASSIFIED_TOOLS.writeOnly,
        ]);
        const missing = registryToolNames().filter((name) => !classified.has(name));
        expect(
            missing,
            `Outils dispatchés mais NON classifiés (default-deny les refusera sans identité) : ${missing.join(', ')}`
        ).toEqual([]);
    });

    it('aucun outil n\'est classé dans deux catégories', () => {
        const mixed = new Set(Object.keys(CLASSIFIED_TOOLS.mixed));
        const overlaps: string[] = [];
        for (const name of CLASSIFIED_TOOLS.readOnly) {
            if (mixed.has(name) || CLASSIFIED_TOOLS.writeOnly.has(name)) overlaps.push(name);
        }
        for (const name of CLASSIFIED_TOOLS.writeOnly) {
            if (mixed.has(name) || CLASSIFIED_TOOLS.readOnly.has(name)) overlaps.push(name);
        }
        for (const name of mixed) {
            if (CLASSIFIED_TOOLS.readOnly.has(name) || CLASSIFIED_TOOLS.writeOnly.has(name)) overlaps.push(name);
        }
        expect(overlaps).toEqual([]);
    });

    it('aucune action mutante connue ne figure dans un ensemble de lecture', () => {
        const offenders: string[] = [];
        for (const [tool, actions] of Object.entries(CLASSIFIED_TOOLS.mixed)) {
            for (const action of actions) {
                if (MUTATING_ACTIONS.has(action)) offenders.push(`${tool}:${action}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('les outils nommés par la revue ne sont pas des lectures pures', () => {
        // roosync_harmonization et roosync_indexing étaient ABSENTS de
        // l'ancienne table d'actions d'écriture : leurs actions mutantes
        // passaient sans identité. roosync_manage classait seulement
        // mark_read/archive — bulk_*/cleanup passaient aussi.
        // roosync_claim : revue ms#1578 défaut 1 — claim/release/extend
        // écrivent active-claims.json, seule la lecture (list/check) passe.
        const pureRead = CLASSIFIED_TOOLS.readOnly;
        expect(pureRead.has('roosync_harmonization')).toBe(false);
        expect(pureRead.has('roosync_indexing')).toBe(false);
        expect(pureRead.has('roosync_manage')).toBe(false);
        expect(pureRead.has('roosync_messages')).toBe(false);
        expect(pureRead.has('roosync_dashboard')).toBe(false);
        expect(pureRead.has('roosync_claim')).toBe(false);
        // ms#1578, bloquant 2 : `roosync_refresh_dashboard` EXÉCUTE un script
        // PowerShell qui écrit dans le store partagé — ce n'est pas une lecture.
        expect(pureRead.has('roosync_refresh_dashboard')).toBe(false);
    });

    it('les quatre « lectures » qui écrivent ne sont plus classées en lecture (ms#1578, bloquant 2)', () => {
        const mixed = CLASSIFIED_TOOLS.mixed;
        expect(mixed.roosync_dashboard.has('refresh')).toBe(false);
        expect(mixed.roosync_baseline.has('export')).toBe(false);
        expect(mixed.roosync_attachments.has('get')).toBe(false);
        // Les lectures légitimes de ces trois outils restent des lectures.
        expect(mixed.roosync_dashboard.has('read')).toBe(true);
        expect(mixed.roosync_baseline.has('list_versions')).toBe(true);
        expect(mixed.roosync_attachments.has('list')).toBe(true);
    });

    it('les actions mutantes nommées par la revue exigent une identité', () => {
        const cases: Array<[string, Record<string, unknown>]> = [
            ['roosync_harmonization', { action: 'create' }],
            ['roosync_harmonization', { action: 'dispatch' }],
            ['roosync_indexing', { action: 'index' }],
            ['roosync_indexing', { action: 'rebuild' }],
            ['roosync_manage', { action: 'bulk_mark_read' }],
            ['roosync_manage', { action: 'bulk_archive' }],
            ['roosync_manage', { action: 'cleanup' }],
            ['roosync_messages', { action: 'send' }],
            ['roosync_messages', { action: 'bulk_archive' }],
            ['roosync_dashboard', { action: 'append' }],
            ['roosync_dashboard', { action: 'merge' }],
            ['roosync_dashboard', { action: 'scrub' }],
            ['roosync_config', { action: 'publish' }],
            ['roosync_baseline', { action: 'restore' }],
            ['roosync_storage_management', { action: 'maintenance' }],
            ['roosync_attachments', { action: 'delete' }],
            // ms#1578 défaut 1 : le verrou de claim est une écriture.
            ['roosync_claim', { action: 'claim', issue: 4149 }],
            ['roosync_claim', { action: 'release', issue: 4149 }],
            ['roosync_claim', { action: 'extend', issue: 4149 }],
            // ms#1578, bloquant 2 : quatre « lectures » qui écrivent.
            ['roosync_refresh_dashboard', { baseline: 'myia-ai-01' }],
            ['roosync_dashboard', { action: 'refresh' }],
            ['roosync_baseline', { action: 'export' }],
            ['roosync_attachments', { action: 'get', uuid: 'x', targetPath: 'C:/tmp/x' }],
        ];
        for (const [tool, args] of cases) {
            const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } };
            expect(classifyCall(body).readOnly, `${tool}(${args.action}) doit exiger une identité`).toBe(false);
        }
    });

    it('les lectures supportées restent des lectures', () => {
        const cases: Array<[string, Record<string, unknown>]> = [
            ['roosync_inventory', { type: 'status' }],
            ['roosync_inventory', { type: 'health' }],
            ['roosync_dashboard', { action: 'read', type: 'workspace' }],
            ['roosync_dashboard', { action: 'read_overview' }],
            ['roosync_messages', { action: 'inbox' }],
            ['roosync_messages', { action: 'stats' }],
            ['roosync_manage', { action: 'stats' }],
            ['roosync_attachments', { action: 'list' }],
            ['roosync_search', { action: 'text' }],
            ['conversation_browser', { action: 'list' }],
            ['roosync_harmonization', { action: 'status' }],
            ['roosync_diagnose', { action: 'health' }],
            ['roosync_indexing', { action: 'status' }],
            ['roosync_storage_management', { action: 'storage' }],
            ['roosync_baseline', { action: 'list_versions' }],
            ['roosync_config', { action: 'collect' }],
            ['export_config', { action: 'get' }],
            // ms#1578 : la LECTURE d'un claim passe sans identité.
            ['roosync_claim', { action: 'list' }],
            ['roosync_claim', { action: 'check', issue: 4149 }],
            // ms#1578 défaut 2 : lire un message SANS mutation reste une
            // lecture — le flag absent ou explicitement faux ne mute rien.
            ['roosync_messages', { action: 'message', message_id: 'm-1' }],
            ['roosync_messages', { action: 'message', message_id: 'm-1', mark_as_read: false }],
        ];
        for (const [tool, args] of cases) {
            const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } };
            expect(classifyCall(body).readOnly, `${tool}(${args.action ?? ''}) doit rester une lecture`).toBe(true);
        }
    });

    it('une lecture qui porte un flag mutateur redevient une écriture', () => {
        const cases: Array<[string, Record<string, unknown>]> = [
            ['roosync_inventory', { type: 'status', resetCache: true }],
            ['roosync_get_status', { resetCache: true }],
            ['roosync_diagnose', { action: 'health', clearCache: true }],
            // ms#1578 défaut 2 : mark_as_read:true mute l'état du message —
            // les DEUX graphies du flag, sur l'outil mixte ET le legacy.
            ['roosync_messages', { action: 'message', message_id: 'm-1', mark_as_read: true }],
            ['roosync_messages', { action: 'message', message_id: 'm-1', markAsRead: true }],
            ['roosync_read', { mode: 'message', message_id: 'm-1', mark_as_read: true }],
        ];
        for (const [tool, args] of cases) {
            const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } };
            expect(classifyCall(body).readOnly, `${tool} avec flag mutateur doit exiger une identité`).toBe(false);
        }
    });

    it('un outil inconnu ou une action inconnue est une écriture (default-deny)', () => {
        const unknownTool = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'outil_inconnu', arguments: {} } };
        expect(classifyCall(unknownTool).readOnly).toBe(false);

        const unknownAction = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'roosync_dashboard', arguments: { action: 'wipe', type: 'workspace' } },
        };
        expect(classifyCall(unknownAction).readOnly).toBe(false);

        const noAction = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'roosync_dashboard', arguments: { type: 'workspace' } },
        };
        expect(classifyCall(noAction).readOnly).toBe(false);
    });
});
