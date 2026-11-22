import { RooSyncServiceError } from '../../../src/types/errors.js';
export { createLogger } from '../../../src/utils/logger.js';

export async function loadService() {
  return import('../../../src/services/lazy-roosync.js');
}

export const errorType = RooSyncServiceError;
