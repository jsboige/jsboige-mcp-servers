import { SERVER_CONFIG } from '../../../src/config/server-config.js';
export { createLogger } from '@vibesync/core/utils/logger';

export async function loadService() {
  return import('../../../src/services/lazy-roosync.js');
}

export const serverConfig = SERVER_CONFIG;
