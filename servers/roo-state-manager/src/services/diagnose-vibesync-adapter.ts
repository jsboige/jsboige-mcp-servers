import type { DiagnoseVibeSyncPort } from '../types/diagnose-contracts.js';
import { registerDiagnoseVibeSyncPort } from './diagnose-registry.js';

export function registerDiagnoseVibeSyncAdapters(): void {
  const port: DiagnoseVibeSyncPort = {
    loadRooSyncModule: () => import('./lazy-roosync.js'),
    reportLifecycle: async args => {
      const { reportLifecycle } = await import('../tools/roosync/lifecycle.js');
      return reportLifecycle(args as Parameters<typeof reportLifecycle>[0]);
    },
    reportRecovery: async args => {
      const { reportRecovery } = await import('../tools/roosync/recovery.js');
      return reportRecovery(args as Parameters<typeof reportRecovery>[0]);
    },
  };
  registerDiagnoseVibeSyncPort(port);
}
