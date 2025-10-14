import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export default async function () {
  // Create a unique temp storage directory for tests
  const storagePath = path.join(os.tmpdir(), `jest-roo-e2e-${process.hrtime().join('-')}`);
  fs.mkdirSync(storagePath, { recursive: true });

  // Provide ROO_STORAGE_PATH for all tests that depend on VS Code globalStorage-like paths
  process.env.ROO_STORAGE_PATH = storagePath;

  // Expose to global so teardown can clean it up
  (global as any).E2E_STORAGE_PATH = storagePath;
}