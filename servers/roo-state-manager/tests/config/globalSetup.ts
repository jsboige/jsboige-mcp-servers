import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export default async function () {
  const storagePath = path.join(os.tmpdir(), `jest-roo-e2e-${process.hrtime().join('-')}`);
  fs.mkdirSync(storagePath, { recursive: true });
  
  const rooPath = path.join(storagePath, '.roo');
  fs.mkdirSync(rooPath, { recursive: true });
  
  const conversationsData = {
    count: 1,
    paths: [path.join(storagePath, 'conversation-1')],
  };
  fs.writeFileSync(path.join(rooPath, 'conversations.json'), JSON.stringify(conversationsData));

  process.env.ROO_STORAGE_PATH = storagePath;
  (global as any).E2E_STORAGE_PATH = storagePath;
};