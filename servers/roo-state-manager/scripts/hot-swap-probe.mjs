/**
 * Acceptance probe for the hot-swap wrapper (#3713).
 *
 * The fix is only proven by walking the exact path that used to break: build
 * while a host is alive, then exercise a dynamic-import-bearing tool call on
 * that host without restarting anything. Three properties, per the dispatch:
 *   (a) no crash — the wrapper process survives the rebuild;
 *   (b) no client-visible break — same stdio pipes, sequential ids, responses
 *       keep arriving (in-flight requests get an explicit error, never a hang);
 *   (c) new code serving — the vintage answering AFTER the swap differs from
 *       the one answering BEFORE (distinct build-info.builtAt, read through
 *       roosync_diagnose from inside the serving process).
 *
 * Method: spawn a fresh wrapper over stdio, handshake, diagnose (vintage 1);
 * patch build-out/index.js (append whitespace → different content hash), republish
 * (marker → vintage 2), wait for the wrapper's swap log, diagnose again. The
 * probe restores build-out and republishes at the end, which lands back on
 * vintage 1's content hash (content-addressed idempotence).
 *
 * Live machines: republishing moves the real `build-current` marker, so any
 * v5 wrapper on this machine swaps too. That is the intended behavior — this
 * probe is the fleet's first live exercise of it.
 *
 * Usage: node scripts/hot-swap-probe.mjs   (from servers/roo-state-manager)
 * Exit 0 = all three properties hold. Non-zero with a named failure otherwise.
 *
 * @version 1.0.0 — issue #3713
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrapperPath = path.join(root, 'mcp-wrapper.cjs');
const outEntry = path.join(root, 'build-out', 'index.js');
const markerFile = path.join(root, 'build-current');

if (!fs.existsSync(outEntry)) {
  console.error('[probe] no build-out/index.js — run npm run build first');
  process.exit(2);
}
if (!fs.existsSync(markerFile)) {
  console.error('[probe] no build-current marker — publish-build has not run here');
  process.exit(2);
}

let nextId = 1;
const pending = new Map();
let stderrTail = [];
let swapCompleteSeen = false;
const swapWaiters = [];

const child = spawn('node', [wrapperPath], {
  cwd: root,
  env: { ...process.env, WORKSPACE_PATH: process.env.WORKSPACE_PATH || root },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

child.stderr.on('data', (d) => {
  const text = d.toString();
  stderrTail.push(text);
  if (stderrTail.length > 50) stderrTail.shift();
  if (text.includes('Hot-swap complete')) {
    swapCompleteSeen = true;
    for (const w of swapWaiters.splice(0)) w();
  }
  if (process.env.PROBE_VERBOSE) process.stderr.write(text);
});

let stdoutBuffer = '';
child.stdout.on('data', (d) => {
  stdoutBuffer += d.toString();
  const lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop() || '';
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const msg = JSON.parse(t);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
      }
    } catch {}
  }
});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function request(method, params, timeoutMs = 120_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout on ${method} after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(msg);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitForSwap(timeoutMs = 45_000) {
  if (swapCompleteSeen) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('swap did not complete in time')), timeoutMs);
    swapWaiters.push(() => { clearTimeout(timer); resolve(); });
  });
}

async function diagnoseBuiltAt(label) {
  const res = await request('tools/call', {
    name: 'roosync_diagnose',
    arguments: { action: 'env' },
  });
  if (res.error) throw new Error(`diagnose failed (${label}): ${JSON.stringify(res.error)}`);
  const text = res.result?.content?.map((c) => c.text || '').join('') || '';
  // The env report embeds the buildVintage JSON among other blocks — extract
  // the fields by pattern rather than assuming one pure JSON document.
  const builtAt = (/"builtAt"\s*:\s*"([^"]+)"/.exec(text) || [])[1] || null;
  const sha = (/"shortSha"\s*:\s*"([^"]+)"/.exec(text) || [])[1] || null;
  console.log(`[probe] ${label}: builtAt=${builtAt} sha=${sha}`);
  if (!builtAt) throw new Error(`no buildVintage.builtAt in diagnose output (${label})`);
  return builtAt;
}

async function main() {
  console.log(`[probe] wrapper pid=${child.pid}`);

  // Handshake
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'hot-swap-probe', version: '1.0.0' },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // Property (a)+(b) baseline: a real tool call through dynamic imports, alive.
  const before = await diagnoseBuiltAt('BEFORE');

  // Rebuild with different content: patch build-out, republish → marker moves.
  const original = fs.readFileSync(outEntry, 'utf-8');
  fs.writeFileSync(outEntry, original + '\n', 'utf-8');
  console.log('[probe] build-out patched (content hash will differ) — republishing…');
  try {
    const publish = spawn('node', [path.join(root, 'scripts', 'publish-build.mjs')], { cwd: root, stdio: 'ignore' });
    await new Promise((res, rej) => { publish.on('exit', (c) => (c === 0 ? res() : rej(new Error(`publish exited ${c}`)))); });
  } finally {
    // Restore build-out immediately; the vintage copy is already published.
    fs.writeFileSync(outEntry, original, 'utf-8');
  }
  console.log(`[probe] republished (marker: ${fs.readFileSync(markerFile, 'utf-8').trim()}) — waiting for hot-swap…`);

  // Property (b): a request fired DURING the swap window must get an answer or
  // an explicit error — never a hang. Fire one immediately; the swap may or may
  // not be done by the time it lands, both paths are valid.
  const inSwapCall = request('tools/call', {
    name: 'roosync_diagnose',
    arguments: { action: 'env' },
  }, 60_000).then((r) => ({ ok: !r.error, error: r.error?.message || null }));

  await waitForSwap();
  const inSwap = await inSwapCall;
  console.log(`[probe] during-swap call answered (ok=${inSwap.ok}${inSwap.error ? `, error="${inSwap.error.slice(0, 80)}"` : ''})`);

  // Property (a): wrapper alive + still answering on the same pipes.
  const after = await diagnoseBuiltAt('AFTER ');

  // Property (c): the serving vintage changed.
  if (before === after) {
    throw new Error(`property (c) FAILED: same builtAt before/after (${before}) — old vintage still serving`);
  }
  console.log('[probe] builtAt changed — new vintage is serving in the SAME session');

  // Property (b) wrap-up: connection still coherent.
  const finalPing = await request('tools/list', {});
  if (finalPing.error) throw new Error(`tools/list after swap failed: ${JSON.stringify(finalPing.error)}`);
  console.log(`[probe] tools/list after swap: ${finalPing.result?.tools?.length} tools — client connection intact`);

  // Cleanup: republish the restored build-out → lands on the original content
  // hash (vintage 1) — idempotent, no leftover state.
  const cleanup = spawn('node', [path.join(root, 'scripts', 'publish-build.mjs')], { cwd: root, stdio: 'ignore' });
  await new Promise((res) => cleanup.on('exit', res));
  console.log(`[probe] cleanup republish done (marker: ${fs.readFileSync(markerFile, 'utf-8').trim()})`);

  console.log('[probe] ✅ ACCEPTANCE PASS — (a) no crash, (b) no client-visible break, (c) new code serving');
  child.stdin.end();
  setTimeout(() => { try { child.kill(); } catch {} process.exit(0); }, 2000).unref();
}

main().catch((err) => {
  console.error(`[probe] ❌ FAIL: ${err.message}`);
  console.error('[probe] last wrapper stderr:');
  console.error(stderrTail.join('').slice(-2000));
  try { child.kill(); } catch {}
  process.exit(1);
});
