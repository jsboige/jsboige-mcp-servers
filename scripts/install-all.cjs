#!/usr/bin/env node

/**
 * Install every server of this repository.
 *
 * Since #4886 (S2 of #2190) `packages/*` and `servers/roo-state-manager` form an
 * npm workspace, installed by one `npm install` at this root. The other servers
 * stay OUTSIDE the workspace on purpose: enrolling them would make the
 * roo-state-manager CI gate depend on their dependency trees, and each keeps its
 * own lockfile. They are installed one by one below.
 *
 * `servers/jupyter-papermill-mcp-server` is a Python server whose package.json is
 * vestigial: it declares `papermill` and `jupyter@^1.0.0`, neither of which
 * exists in the npm registry (measured #4886). Running `npm install` there fails
 * for every caller, so it is skipped; its Python deps live in requirements.txt.
 *
 * Kept dependency-free on purpose: it must run before `node_modules` exists.
 */

const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');

const OUT_OF_WORKSPACE = [
  'servers/jinavigator-server',
  'servers/jupyter-mcp-server',
];

function install(cwd, label) {
  console.log(`🚀 ${label}...`);
  execSync('npm install', { cwd, stdio: 'inherit' });
  console.log(`✅ ${label} installé.`);
}

try {
  install(root, 'Workspaces (packages/* + servers/roo-state-manager)');
  for (const server of OUT_OF_WORKSPACE) {
    install(path.join(root, server), server);
  }
  console.log('✅ Installation terminée.');
} catch (error) {
  console.error('❌ Échec de npm install :', error.message);
  process.exit(1);
}