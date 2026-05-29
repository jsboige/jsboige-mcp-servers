/**
 * Zoo-Code Storage Detector
 *
 * Detects and scans Zoo-Code globalStorage (`zoocodeorganization.zoo-code`).
 * Zoo-Code is a Roo/Cline fork with identical storage format:
 *   - tasks/{uuid}/task_metadata.json
 *   - tasks/{uuid}/ui_messages.json
 *   - tasks/{uuid}/history_item.json
 *   - tasks/_index.json
 *
 * This detector identifies Zoo-Code specific storage locations so that tasks
 * can be correctly attributed to source 'zoo-code' rather than 'roo'.
 *
 * @module utils/zoo-storage-detector
 * @issue #2429
 */

import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    StorageStats,
} from '../types/conversation.js';
import { globalCacheManager } from './cache-manager.js';

/** Zoo-Code extension publisher directory name */
export const ZOO_CODE_EXTENSION_ID = 'zoocodeorganization.zoo-code';

/**
 * Lightweight detector for Zoo-Code storage locations.
 *
 * Zoo-Code shares the same on-disk format as Roo Code (it's a fork).
 * The difference is purely in the extension ID / directory name.
 * This class handles detection and attribution; actual parsing is
 * delegated to RooStorageDetector since the format is identical.
 */
export class ZooStorageDetector {
    private static readonly CACHE_KEY = 'zoo_storage_locations';

    private static readonly COMMON_GLOBAL_STORAGE_PATHS = [
        path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage'),
        path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage'),
        path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
    ];

    /**
     * Detect Zoo-Code storage locations on this machine.
     * Returns paths to the extension's globalStorage directory that contain a 'tasks' subdirectory.
     */
    public static async detectStorageLocations(): Promise<string[]> {
        // Check cache
        const cached = await globalCacheManager.get<string[]>(ZooStorageDetector.CACHE_KEY);
        if (cached) {
            return cached;
        }

        const locations: string[] = [];

        for (const basePath of ZooStorageDetector.COMMON_GLOBAL_STORAGE_PATHS) {
            const zooPath = path.join(basePath, ZOO_CODE_EXTENSION_ID);
            if (existsSync(zooPath)) {
                const tasksPath = path.join(zooPath, 'tasks');
                if (existsSync(tasksPath)) {
                    locations.push(zooPath);
                }
            }
        }

        // Cache results
        await globalCacheManager.set(ZooStorageDetector.CACHE_KEY, locations);

        return locations;
    }

    /**
     * Get stats for a Zoo-Code storage path.
     * Reuses the same stat approach as RooStorageDetector.
     */
    public static async getStatsForPath(storagePath: string): Promise<StorageStats> {
        let count = 0;
        let totalSize = 0;
        let lastActivity: Date | null = null;

        const tasksPath = path.join(storagePath, 'tasks');
        const entries = await fs.readdir(tasksPath, { withFileTypes: true });

        if (!entries || !Array.isArray(entries)) {
            return { conversationCount: 0, totalSize: 0, fileTypes: {} };
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === '_index.json') continue;
            const taskPath = path.join(tasksPath, entry.name);
            try {
                let dirSize = 0;
                let dirMtime: Date | null = null;
                const files = await fs.readdir(taskPath);
                for (const file of files) {
                    try {
                        const fileStat = await fs.stat(path.join(taskPath, file));
                        if (fileStat.isFile()) dirSize += fileStat.size;
                        if (!dirMtime || fileStat.mtime > dirMtime) dirMtime = fileStat.mtime;
                    } catch { /* skip */ }
                }
                count++;
                totalSize += dirSize;
                if (dirMtime && (!lastActivity || dirMtime > lastActivity)) {
                    lastActivity = dirMtime;
                }
            } catch { /* skip */ }
        }

        return { conversationCount: count, totalSize, fileTypes: {} };
    }

    /**
     * Get overall storage stats for Zoo-Code on this machine.
     */
    public static async getStorageStats(): Promise<{
        totalLocations: number;
        totalConversations: number;
        totalSize: number;
    }> {
        const locations = await ZooStorageDetector.detectStorageLocations();
        let totalConversations = 0;
        let totalSize = 0;

        for (const loc of locations) {
            const stats = await ZooStorageDetector.getStatsForPath(loc);
            totalConversations += stats.conversationCount;
            totalSize += stats.totalSize;
        }

        return {
            totalLocations: locations.length,
            totalConversations,
            totalSize,
        };
    }

    /**
     * Check whether a given storage path belongs to Zoo-Code.
     * Used to distinguish Zoo tasks from Roo tasks when both are found
     * by RooStorageDetector's glob patterns.
     */
    public static isZooCodePath(storagePath: string): boolean {
        const normalized = storagePath.replace(/\\/g, '/').toLowerCase();
        return normalized.includes('zoocodeorganization.zoo-code');
    }

    /**
     * Validate a custom path as a Zoo-Code storage location.
     */
    public static async validateCustomPath(customPath: string): Promise<boolean> {
        try {
            const normalizedPath = path.resolve(customPath);
            const tasksPath = path.join(normalizedPath, 'tasks');
            return existsSync(tasksPath);
        } catch {
            return false;
        }
    }
}
