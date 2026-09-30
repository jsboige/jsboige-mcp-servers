/**
 * In-memory filesystem backing the mock-parity harness (#1320).
 *
 * Implements the exact fs/promises + fs surface used by the dashboard and
 * message storage paths (enumerated by grep over the tool sources): readFile,
 * writeFile (w/wx), appendFile, copyFile, unlink, mkdir, stat, access,
 * readdir, rename, rm, open(+FileHandle.read), and the sync twins of the
 * subset that shared-state-path/logger touch.
 *
 * Design rules:
 * - Directories are IMPLICIT: a directory exists iff a file key lives under
 *   it. mkdir recursive is therefore a no-op (except EEXIST on a file).
 * - Keys are normalized to forward slashes so the same logical path works on
 *   Windows (real code uses path.join → backslashes) and in the Map.
 * - Errors carry Node-style `code` properties (ENOENT, EEXIST, EISDIR) so the
 *   code under test cannot distinguish the mock from real fs by error shape.
 *
 * @module tests/mock-parity/in-memory-fs
 * @version 1.0.0
 */

export interface FileEntry {
  content: string;
  mtimeMs: number;
}

export interface BridgeState {
  backend: 'real' | 'memory';
  files: Map<string, FileEntry>;
  /** Explicitly mkdir'd directories (normalized keys). Directories also exist implicitly under any file key. */
  dirs: Set<string>;
}

export function createBridgeState(): BridgeState {
  return { backend: 'real', files: new Map(), dirs: new Set() };
}

function normalizeKey(p: string): string {
  return p.replace(/\\/g, '/');
}

function nodeError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function isDirectory(files: Map<string, FileEntry>, dirs: Set<string>, key: string): boolean {
  if (dirs.has(key)) return true;
  for (const k of files.keys()) {
    if (k.startsWith(key + '/')) return true;
  }
  return false;
}

function toContent(data: string | Buffer | Uint8Array): string {
  return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
}

interface StatLike {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
  mtime: Date;
}

function statEntry(entry: FileEntry): StatLike {
  return {
    isFile: () => true,
    isDirectory: () => false,
    size: Buffer.byteLength(entry.content, 'utf8'),
    mtimeMs: entry.mtimeMs,
    mtime: new Date(entry.mtimeMs),
  };
}

function statDir(): StatLike {
  return {
    isFile: () => false,
    isDirectory: () => true,
    size: 0,
    mtimeMs: 0,
    mtime: new Date(0),
  };
}

/** The in-memory implementation of the enumerated fs surface. */
export const memoryFs = {
  async readFile(path: string | URL, ...rest: unknown[]): Promise<string | Buffer> {
    const encoding = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { encoding?: string } | undefined)?.encoding;
    const key = normalizeKey(String(path));
    const entry = memoryFsState().files.get(key);
    if (entry === undefined) {
      if (isDirectory(memoryFsState().files, memoryFsState().dirs, key)) throw nodeError('EISDIR', 'illegal operation on a directory, read');
      throw nodeError('ENOENT', `no such file or directory, open '${key}'`);
    }
    return encoding ? entry.content : Buffer.from(entry.content, 'utf8');
  },

  async writeFile(path: string | URL, data: string | Buffer | Uint8Array, ...rest: unknown[]): Promise<void> {
    const opts = rest[0];
    const flag = typeof opts === 'string' ? opts : ((opts as { flag?: string } | undefined)?.flag ?? 'w');
    const key = normalizeKey(String(path));
    const existing = memoryFsState().files.get(key);
    if (flag.includes('x') && existing !== undefined) {
      throw nodeError('EEXIST', `file already exists, open '${key}'`);
    }
    memoryFsState().files.set(key, { content: toContent(data), mtimeMs: Date.now() });
  },

  async appendFile(path: string | URL, data: string | Buffer | Uint8Array): Promise<void> {
    const key = normalizeKey(String(path));
    const existing = memoryFsState().files.get(key);
    memoryFsState().files.set(key, {
      content: (existing?.content ?? '') + toContent(data),
      mtimeMs: Date.now(),
    });
  },

  async copyFile(src: string | URL, dst: string | URL): Promise<void> {
    const srcKey = normalizeKey(String(src));
    const entry = memoryFsState().files.get(srcKey);
    if (entry === undefined) throw nodeError('ENOENT', `no such file or directory, copyfile '${srcKey}'`);
    memoryFsState().files.set(normalizeKey(String(dst)), { content: entry.content, mtimeMs: Date.now() });
  },

  async unlink(path: string | URL): Promise<void> {
    const key = normalizeKey(String(path));
    if (!memoryFsState().files.delete(key)) {
      throw nodeError('ENOENT', `no such file or directory, unlink '${key}'`);
    }
  },

  async mkdir(path: string | URL, options?: { recursive?: boolean } | boolean): Promise<void> {
    const key = normalizeKey(String(path));
    if (memoryFsState().files.has(key)) {
      throw nodeError('EEXIST', `file already exists, mkdir '${key}'`);
    }
    memoryFsState().dirs.add(key);
    void options;
  },

  async stat(path: string | URL): Promise<StatLike> {
    const key = normalizeKey(String(path));
    const entry = memoryFsState().files.get(key);
    if (entry !== undefined) return statEntry(entry);
    if (isDirectory(memoryFsState().files, memoryFsState().dirs, key)) return statDir();
    throw nodeError('ENOENT', `no such file or directory, stat '${key}'`);
  },

  async access(path: string | URL): Promise<void> {
    const key = normalizeKey(String(path));
    if (memoryFsState().files.has(key) || isDirectory(memoryFsState().files, memoryFsState().dirs, key)) return;
    throw nodeError('ENOENT', `no such file or directory, access '${key}'`);
  },

  async readdir(path: string | URL, options?: { withFileTypes?: boolean }): Promise<string[]> {
    if (options?.withFileTypes) {
      throw new Error('InMemoryFs: readdir withFileTypes not implemented — add it if a scenario needs it');
    }
    const key = normalizeKey(String(path));
    const prefix = key.endsWith('/') ? key : key + '/';
    const children = new Set<string>();
    let found = false;
    for (const k of memoryFsState().files.keys()) {
      if (k === key) throw nodeError('ENOTDIR', 'not a directory, scandir');
      if (k.startsWith(prefix)) {
        found = true;
        const rest = k.slice(prefix.length);
        const first = rest.split('/')[0];
        children.add(first);
      }
    }
    if (!found && !memoryFsState().files.has(key) && !memoryFsState().dirs.has(key)) {
      throw nodeError('ENOENT', `no such file or directory, scandir '${key}'`);
    }
    return [...children].sort();
  },

  async rename(oldPath: string | URL, newPath: string | URL): Promise<void> {
    const from = normalizeKey(String(oldPath));
    const to = normalizeKey(String(newPath));
    const entry = memoryFsState().files.get(from);
    if (entry === undefined) throw nodeError('ENOENT', `no such file or directory, rename '${from}'`);
    memoryFsState().files.delete(from);
    memoryFsState().files.set(to, { content: entry.content, mtimeMs: Date.now() });
  },

  async rm(path: string | URL, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const key = normalizeKey(String(path));
    const direct = memoryFsState().files.get(key);
    if (direct !== undefined) {
      memoryFsState().files.delete(key);
      return;
    }
    if (isDirectory(memoryFsState().files, memoryFsState().dirs, key)) {
      if (!options?.recursive) {
        throw nodeError('ERR_FS_EISDIR', `Path is a directory: rm '${key}'`);
      }
      for (const k of [...memoryFsState().files.keys()]) {
        if (k.startsWith(key + '/')) memoryFsState().files.delete(k);
      }
      return;
    }
    if (!options?.force) throw nodeError('ENOENT', `no such file or directory, rm '${key}'`);
  },

  async open(path: string | URL, flags: string | number): Promise<{
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }>;
    close(): Promise<void>;
  }> {
    if (typeof flags === 'string' && !flags.includes('r')) {
      throw new Error(`InMemoryFs: open flag '${flags}' not implemented — only 'r' is used by the parity surface`);
    }
    const key = normalizeKey(String(path));
    const entry = memoryFsState().files.get(key);
    if (entry === undefined) throw nodeError('ENOENT', `no such file or directory, open '${key}'`);
    const buf = Buffer.from(entry.content, 'utf8');
    let closed = false;
    return {
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        if (closed) throw nodeError('EBADF', 'file handle closed');
        const end = Math.min(position + length, buf.length);
        const slice = buf.subarray(position, end);
        slice.copy(buffer, offset);
        return { bytesRead: slice.length, buffer };
      },
      async close() {
        closed = true;
      },
    };
  },

  // ===== Sync surface (shared-state-path / logger path) =====

  existsSync(path: string | URL): boolean {
    const key = normalizeKey(String(path));
    return memoryFsState().files.has(key) || isDirectory(memoryFsState().files, memoryFsState().dirs, key);
  },

  readFileSync(path: string | URL, encoding?: BufferEncoding): string | Buffer {
    const key = normalizeKey(String(path));
    const entry = memoryFsState().files.get(key);
    if (entry === undefined) throw nodeError('ENOENT', `no such file or directory, open '${key}'`);
    return encoding ? entry.content : Buffer.from(entry.content, 'utf8');
  },

  writeFileSync(path: string | URL, data: string | Buffer | Uint8Array): void {
    memoryFsState().files.set(normalizeKey(String(path)), { content: toContent(data), mtimeMs: Date.now() });
  },

  mkdirSync(path: string | URL): void {
    const key = normalizeKey(String(path));
    if (memoryFsState().files.has(key)) {
      throw nodeError('EEXIST', `file already exists, mkdir '${key}'`);
    }
    memoryFsState().dirs.add(key);
  },

  statSync(path: string | URL): StatLike {
    const key = normalizeKey(String(path));
    const entry = memoryFsState().files.get(key);
    if (entry !== undefined) return statEntry(entry);
    if (isDirectory(memoryFsState().files, memoryFsState().dirs, key)) return statDir();
    throw nodeError('ENOENT', `no such file or directory, stat '${key}'`);
  },
};

// The bridge state is injected by the mock factories (hoisted singleton lives
// in the test file, outside the resettable module graph — see mock-parity.test.ts).
let _state: BridgeState | null = null;
export function bindBridgeState(state: BridgeState): void {
  _state = state;
}
function memoryFsState(): BridgeState {
  if (_state === null) throw new Error('InMemoryFs: bindBridgeState() must be called by the fs mock factories first');
  return _state;
}

/**
 * Build the 'fs/promises' module replacement: full real surface, with the
 * enumerated functions dispatched to the in-memory backend when active.
 * Un-enumerated exotic functions keep hitting the real fs in BOTH modes —
 * acceptable for the parity surface; the README documents how to extend.
 */
export function buildPromisesModule(
  state: BridgeState,
  real: typeof import('fs/promises')
): typeof import('fs/promises') {
  const d = <A extends unknown[]>(realFn: (...a: A) => unknown, memFn: (...a: A) => unknown) =>
    (...a: A) => (state.backend === 'memory' ? memFn(...a) : realFn(...a));
  return {
    ...real,
    readFile: d(real.readFile, memoryFs.readFile) as typeof real.readFile,
    writeFile: d(real.writeFile, memoryFs.writeFile) as typeof real.writeFile,
    appendFile: d(real.appendFile, memoryFs.appendFile) as typeof real.appendFile,
    copyFile: d(real.copyFile, memoryFs.copyFile) as typeof real.copyFile,
    unlink: d(real.unlink, memoryFs.unlink) as typeof real.unlink,
    mkdir: d(real.mkdir, memoryFs.mkdir) as typeof real.mkdir,
    stat: d(real.stat, memoryFs.stat) as typeof real.stat,
    access: d(real.access, memoryFs.access) as typeof real.access,
    readdir: d(real.readdir, memoryFs.readdir) as typeof real.readdir,
    rename: d(real.rename, memoryFs.rename) as typeof real.rename,
    rm: d(real.rm, memoryFs.rm) as typeof real.rm,
    open: d(real.open, memoryFs.open) as unknown as typeof real.open,
  };
}

/**
 * Build the 'fs' module replacement: real module spread, sync functions of
 * the parity surface dispatched, AND the `promises` namespace dispatched too —
 * several modules do `import { promises as fs } from 'fs'` (MessageManager,
 * cache-manager, server-helpers), which bypasses a bare 'fs/promises' mock.
 */
export function buildSyncModule(state: BridgeState, real: typeof import('fs')): typeof import('fs') {
  const d = <A extends unknown[]>(realFn: (...a: A) => unknown, memFn: (...a: A) => unknown) =>
    (...a: A) => (state.backend === 'memory' ? memFn(...a) : realFn(...a));
  return {
    ...real,
    // `import { promises as fs } from 'fs'` must not resurrect the real fs/promises.
    promises: buildPromisesModule(state, real.promises as typeof import('fs/promises')),
    existsSync: d(real.existsSync, memoryFs.existsSync),
    readFileSync: d(real.readFileSync, memoryFs.readFileSync),
    writeFileSync: d(real.writeFileSync, memoryFs.writeFileSync),
    mkdirSync: d(real.mkdirSync, memoryFs.mkdirSync),
    statSync: d(real.statSync, memoryFs.statSync),
  } as typeof import('fs');
}
