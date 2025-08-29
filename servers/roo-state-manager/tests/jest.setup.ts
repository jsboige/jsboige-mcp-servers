import * as esbuild from 'esbuild';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function buildTestHelpers() {
  const proxyEntryPoint = path.resolve(__dirname, 'e2e', 'proxy.ts');
  const outfile = path.resolve(__dirname, 'e2e', 'proxy.js');

  console.log('Building test helpers...');
  await esbuild.build({
    entryPoints: [proxyEntryPoint],
    bundle: true,
    outfile,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    external: ['http', 'http-proxy'],
  });
  console.log('Test helpers built successfully.');
}

buildTestHelpers().catch(err => {
  console.error(err);
  process.exit(1);
});