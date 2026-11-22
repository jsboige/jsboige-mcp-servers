import type { Dashboard } from '../../tools/roosync/dashboard-schemas.js';
import type { CondenseLockInfo } from '../../tools/roosync/dashboard.js';
import { withAppendLock, writeDashboardFile } from '../../tools/roosync/dashboard.js';

export const FORK_FILE_RE = /\s\(\d+\)\.md$/;

export function isGdriveConflictCopyFile(nameOrKey: string): boolean {
  return FORK_FILE_RE.test(nameOrKey.endsWith('.md') ? nameOrKey : `${nameOrKey}.md`);
}

export function canonicalKeyOfFork(key: string): string {
  return key.replace(/(\s\(\d+\))+$/, '');
}

export async function repairDashboardMirrorFromPg(
  key: string,
  dashboard: Dashboard
): Promise<void> {
  const holder: CondenseLockInfo = {
    machineId: process.env.ROOSYNC_MACHINE_ID || 'unknown',
    workspace: 'mirror-repair',
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  };
  const mirrorExportAt = new Date().toISOString();
  await withAppendLock(key, holder, async () => {
    const wv = await writeDashboardFile(key, dashboard, undefined, {
      pgPrimaryPreWritten: true,
      mirrorExportAt
    });
    if (wv.gdriveDegraded) {
      throw new Error(`moitié GDrive dégradée à la réparation du miroir : ${wv.gdriveDegraded}`);
    }
  });
}
