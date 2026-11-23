#!/usr/bin/env node

/**
 * Install every workspace of this repository.
 *
 * Since #4886 (S2 of #2190) the repository is an npm workspace root, so a single
 * `npm install` here installs `servers/*` and `packages/*` and links
 * `@vibesync/core` into the consumers. This script stays as the documented
 * entry point (`npm run install-all`) and delegates to that one install.
 *
 * Kept dependency-free on purpose: it must run before `node_modules` exists.
 */

const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');

console.log('🚀 Installation des workspaces MCP (servers/* + packages/*)...');

try {
  execSync('npm install', { cwd: root, stdio: 'inherit' });
  console.log('✅ Workspaces installés.');
} catch (error) {
  console.error('❌ Échec de npm install :', error.message);
  process.exit(1);
}