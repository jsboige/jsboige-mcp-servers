import * as fs from 'fs';

export default async function () {
  const storagePath = (global as any).E2E_STORAGE_PATH;
  if (storagePath) {
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
};