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
 * Since #4918 a vintage is AUTONOMOUS in its workspace dependencies. npm links
 * `@vibesync/core` under node_modules, but the package lives in
 * packages/vibesync-core: one dist/ for every vintage, rebuilt in place, even
 * under live hosts. A vintage therefore carries its own copy of each workspace
 * package the server depends on, under `<vintage>/node_modules/<name>`, and
 * that copy is part of the vintage id. Node resolves a bare specifier by
 * walking up from the importing file, so a module loaded late from a running
 * vintage reads the copy it was published with, never the dist/ of a later
 * build.
 *
 * Publication completeness (ms#1910 review of #4918): a vintage directory only
 * ever appears under its FINAL name through an atomic rename of a staged tree
 * whose content hash — recomputed on the copy — equals that name. A copy
 * interrupted by a crash leaves `build-<id>.staging-<pid>` behind, which is
 * never listed, never marked, and is discarded by the next publish. An
 * existing directory whose content no longer hashes to its own name is an
 * incomplete or corrupted copy: the publish refuses it and never marks it.
 * The id IS the completion witness — a first-copied file (package.json) says
 * nothing about the files that follow it.
 *
 * @version 1.2.0 — ms#1910 review (staged publication, hash verified on the
 *   copy, stale staging cleanup, runtime files excluded from the read-back,
 *   workspace packages read from `dependencies` and told from regular ones by
 *   the install tree); 1.1.0 — issue #4918 (bundled workspace dependencies);
 *   1.0.0 — #3713
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const VINTAGE_PATTERN = /^build-[0-9a-f]{16}$/;

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** "relpath:filehash" lines of one tree (or a single file), mounted at `mount`. */
function collectTree(item, mount, entries) {
  if (fs.statSync(item).isFile()) {
    entries.push(`${mount}:${digest(item)}`);
    return;
  }
  for (const ent of fs.readdirSync(item, { withFileTypes: true })) {
    const relPath = mount ? `${mount}/${ent.name}` : ent.name;
    const abs = path.join(item, ent.name);
    if (ent.isDirectory()) collectTree(abs, relPath, entries);
    else if (ent.isFile()) entries.push(`${relPath}:${digest(abs)}`);
  }
}

/** Deterministic tree hash: sha256 over sorted "relpath:filehash" lines. */
export function hashTree(dir) {
  const entries = [];
  collectTree(dir, '', entries);
  entries.sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

/**
 * Same hash over several trees that sit side by side in one vintage:
 * `parts` is [[mount, dirOrFile], …], the mount being the path inside the
 * vintage. With parts beyond the root tree the result differs from
 * `hashTree(root)`, so a vintage published before #4918 is never taken for an
 * autonomous one.
 */
export function hashTrees(parts) {
  const entries = [];
  for (const [mount, item] of parts) collectTree(item, mount, entries);
  entries.sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

/** `bundledParts` describes what a vintage carries besides its own tree. */
export function vintageNameFor(dir, bundled = []) {
  return `build-${hashTrees([['', dir], ...bundled]).slice(0, 16)}`;
}

/** What the copy of a workspace package carries: its manifest and its build. */
export const BUNDLED_ENTRIES = ['package.json', 'dist'];

/** Where the vintage carries dependency `name`: `<vintage>/node_modules/<name>`. */
export function bundleMount(name) {
  return ['node_modules', ...name.split('/')].join('/');
}

/**
 * Where Node finds `name` from `fromDir` — node_modules/<name> at every level
 * walking up — at the path it was installed at: a link for a workspace
 * member, a directory for a regular dependency. null when not installed.
 */
export function findInstalledPackage(name, fromDir) {
  const segments = ['node_modules', ...name.split('/')];
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, ...segments);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

/** The node_modules directory holding `entry` — the install tree an entry never leaves unless it is a link out of it. */
function installTreeOf(entry) {
  for (let dir = entry; ; dir = path.dirname(dir)) {
    if (path.basename(dir) === 'node_modules') return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

function isInside(tree, dir) {
  const rel = path.relative(tree, dir);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * A regular dependency is installed inside the node_modules tree that holds
 * its entry and never leaves it — a pnpm store too, which links to `.pnpm/`
 * under the same tree. npm links a workspace member from elsewhere: its
 * source tree, rebuilt in place, so its real path escapes that tree. The test
 * is on that escape, not on the segments of the real path — a workspace
 * checked out under a folder named node_modules is still a workspace
 * (ms#1910 review).
 */
function isRegularDependency(entry, realDir) {
  const tree = installTreeOf(entry);
  return tree !== null && isInside(tree, realDir);
}

/**
 * The dependencies of the package at `packageDir` that are workspace packages
 * — the ones a vintage must carry. Returns [{ name, realDir }].
 *
 * `dependencies` only: what the emitted code resolves at runtime is declared
 * there. A devDependency is build- and test-time, and a workspace package
 * declared as one must not be able to fail the publish for lack of a build
 * (ms#1910 review).
 */
export function workspaceDependencies(packageDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8'));
  const bundled = [];
  for (const name of Object.keys(manifest.dependencies || {})) {
    const entry = findInstalledPackage(name, packageDir);
    if (!entry) continue;
    const realDir = fs.realpathSync(entry);
    if (!isRegularDependency(entry, realDir)) bundled.push({ name, realDir });
  }
  return bundled;
}

/** The files of the bundled packages, as [[mount, fileOrDir], …] for `vintageNameFor`. */
export function bundledParts(bundled) {
  const parts = [];
  for (const { name, realDir } of bundled) {
    const mount = bundleMount(name);
    for (const entry of BUNDLED_ENTRIES) {
      const item = path.join(realDir, entry);
      if (!fs.existsSync(item)) {
        throw new Error(`cannot bundle ${name} into the vintage: ${item} is missing - build it before publishing`);
      }
      parts.push([`${mount}/${entry}`, item]);
    }
  }
  return parts;
}

/**
 * Copy a directory tree or a single file. Regular files only: a link is
 * neither followed nor recreated.
 */
export function copyTree(src, dst) {
  if (fs.statSync(src).isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return 1;
  }
  let copied = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.isDirectory()) copied += copyTree(path.join(src, ent.name), path.join(dst, ent.name));
    else if (ent.isFile()) {
      fs.copyFileSync(path.join(src, ent.name), path.join(dst, ent.name));
      copied += 1;
    }
  }
  return copied;
}

/**
 * Put the bundled packages inside a freshly staged vintage directory. Returns
 * the number of files written. Nothing is inferred from what the target
 * already holds: publication stages a NEW tree and renames it into place, so
 * there is no "already bundled" state to detect — and none to get wrong. (The
 * test this replaces — package.json present — was the first file copied, not
 * the last: an interrupted copy passed it with a partial dist/.)
 */
export function bundleInto(vintageDir, bundled) {
  let written = 0;
  for (const { name, realDir } of bundled) {
    const target = path.join(vintageDir, ...bundleMount(name).split('/'));
    for (const entry of BUNDLED_ENTRIES) {
      written += copyTree(path.join(realDir, entry), path.join(target, entry));
    }
  }
  return written;
}

/** `<vintage>.staging-<pid>`: a tree being copied. Not a vintage — no marker can name it, no wrapper can serve it, no listing shows it. */
export function stagingPathFor(vintagePath, pid = process.pid) {
  return `${vintagePath}.staging-${pid}`;
}

const STAGING_PATTERN = /^build-[0-9a-f]{16}\.staging-(\d+)$/;

/**
 * Remove the staging trees of publish processes that are gone — the pid
 * liveness convention of `.ref-<pid>`. A live pid's staging belongs to a
 * concurrent publish and is left alone. Returns the names removed.
 */
export function cleanStaleStaging(root, { alive = isPidAlive } = {}) {
  const removed = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const m = STAGING_PATTERN.exec(ent.name);
    if (!m || !ent.isDirectory() || alive(Number.parseInt(m[1], 10))) continue;
    fs.rmSync(path.join(root, ent.name), { recursive: true, force: true });
    removed.push(ent.name);
  }
  return removed;
}

/**
 * Files a vintage gains AFTER it was published. They date it or belong to the
 * host serving it; they are not its content. Every writer into a vintage root
 * must be listed here: write-build-info.mjs, mcp-wrapper.cjs (twice).
 */
const isPostPublicationFile = (name) =>
  name === 'build-info.json' || name === '.tools-cache.json' || /^\.ref-\d+$/.test(name);

/**
 * The vintage name a directory on disk actually carries: its content hash read
 * back from the copy, without the post-publication files at its root (and
 * ONLY at its root — a bundled dist keeps every file it has).
 *
 * Equals the name the sources gave (`vintageNameFor`) when the copy is
 * faithful. Any other result is an incomplete or corrupted tree: the id is
 * what proves a copy complete, so such a directory is never marked current.
 */
export function vintageNameOnDisk(dir) {
  const entries = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isPostPublicationFile(ent.name)) continue;
    if (ent.isDirectory()) collectTree(path.join(dir, ent.name), ent.name, entries);
    else if (ent.isFile()) entries.push(`${ent.name}:${digest(path.join(dir, ent.name))}`);
  }
  entries.sort();
  return `build-${createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16)}`;
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
