/**
 * Content-addressed vintage store — the pure mechanics behind
 * scripts/publish-build.mjs (#3713).
 *
 * Extracted as a library because retention DELETES directories: the one
 * destructive path of the hot-swap pipeline deserves direct unit coverage
 * (keep current, keep N most recent, keep anything a live wrapper pins via
 * `.ref-<pid>`, prune the rest, clean dead refs first).
 *
 * A "vintage" is `build-<16 hex>` at the server root; content hash is a
 * sha256 over sorted `relpath:filehash` lines of the emitted tree, so an
 * identical rebuild resolves to the same vintage (idempotent publish).
 *
 * @version 1.0.0 — issue #3713
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const VINTAGE_PATTERN = /^build-[0-9a-f]{16}$/;

/** Deterministic tree hash: sha256 over sorted "relpath:filehash" lines. */
export function hashTree(dir) {
  const entries = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(relPath);
      else if (ent.isFile()) {
        const content = fs.readFileSync(path.join(dir, relPath));
        entries.push(`${relPath}:${createHash('sha256').update(content).digest('hex')}`);
      }
    }
  };
  walk('');
  entries.sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

export function vintageNameFor(dir) {
  return `build-${hashTree(dir).slice(0, 16)}`;
}

/** Vintages present under root, newest first (directory mtime). */
export function listVintages(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && VINTAGE_PATTERN.test(e.name))
    .map((e) => ({ name: e.name, mtimeMs: fs.statSync(path.join(root, e.name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** A vintage is pinned while any `.ref-<pid>` names a live process. */
export function vintageHasLiveRef(dir, alive = isPidAlive) {
  try {
    return fs.readdirSync(dir).some((f) => {
      const m = /^\.ref-(\d+)$/.exec(f);
      return m && alive(Number.parseInt(m[1], 10));
    });
  } catch { return false; }
}

/**
 * Apply retention in place: keep the current vintage, the (retention-1) most
 * recent others, and anything pinned by a live wrapper ref; prune the rest.
 * Dead `.ref-<pid>` files are removed first so they never count as pins.
 * Returns { pruned: string[], kept: string[], pinned: string[] }.
 */
export function pruneVintages(root, { currentName, retention = 3, alive = isPidAlive }) {
  for (const v of listVintages(root)) {
    const dir = path.join(root, v.name);
    for (const f of fs.readdirSync(dir)) {
      const m = /^\.ref-(\d+)$/.exec(f);
      if (m && !alive(Number.parseInt(m[1], 10))) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
  }

  const vintages = listVintages(root);
  const keep = new Set([currentName]);
  for (const v of vintages) {
    if (keep.size >= retention) break;
    keep.add(v.name);
  }

  const pruned = [];
  const pinned = [];
  for (const v of vintages) {
    if (keep.has(v.name)) continue;
    const dir = path.join(root, v.name);
    if (vintageHasLiveRef(dir, alive)) {
      pinned.push(v.name);
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    pruned.push(v.name);
  }
  return {
    pruned,
    pinned,
    kept: vintages.filter((v) => keep.has(v.name)).map((v) => v.name),
  };
}
