import type { DiagnoseVibeSyncPort } from '../types/diagnose-contracts.js';

let port: DiagnoseVibeSyncPort | undefined;

export function registerDiagnoseVibeSyncPort(implementation: DiagnoseVibeSyncPort): void {
  port = implementation;
}

export async function getDiagnoseVibeSyncPort(): Promise<DiagnoseVibeSyncPort> {
  if (!port) {
    const { registerDiagnoseVibeSyncAdapters } = await import('./diagnose-vibesync-adapter.js');
    registerDiagnoseVibeSyncAdapters();
  }
  return port!;
}
