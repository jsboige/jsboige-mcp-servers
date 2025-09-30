import * as fs from 'fs';

export default async function () {
  try {
    const storagePath = (global as any).E2E_STORAGE_PATH as string | undefined;
    if (storagePath && fs.existsSync(storagePath)) {
      // Node 18+: prefer rmSync over deprecated rmdir
      fs.rmSync(storagePath, { recursive: true, force: true });
    }
  } catch {
    // best effort cleanup; ignore errors in teardown
  }
}