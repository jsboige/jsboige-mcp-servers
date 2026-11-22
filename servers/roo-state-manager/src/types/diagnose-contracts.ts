export interface DiagnoseLifecycleResult {
  success: boolean;
  fromState: string;
  toState: string;
  error?: string;
}

export interface DiagnoseRecoveryResult {
  success: boolean;
  mode: string;
  error?: string;
  matchedAction?: string;
  description?: string;
}

export interface DiagnoseRooSyncModule {
  RooSyncService: {
    resetInstance(): Promise<void>;
    getInstance(options?: { enabled?: boolean }): Promise<any>;
  };
  getRooSyncService(): Promise<any>;
}

export interface DiagnoseVibeSyncPort {
  loadRooSyncModule(): Promise<DiagnoseRooSyncModule>;
  reportLifecycle(args: { state: string; machineId?: string; reason?: string }): Promise<DiagnoseLifecycleResult>;
  reportRecovery(args: {
    errorMessage?: string;
    outcomeAction?: string;
    success?: boolean;
    machineId?: string;
    limit?: number;
  }): Promise<DiagnoseRecoveryResult>;
}
