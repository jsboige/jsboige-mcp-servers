/**
 * #4886 S2 grain 3 — the one `pg` the server's tests must resolve.
 *
 * `pg` is installed twice in the workspace: the server's own copy
 * (servers/roo-state-manager/node_modules/pg) and the root copy that
 * @vibesync/core resolves from packages/vibesync-core/. A published vintage
 * carries only the first, so every module it loads — the bundled package
 * included — resolves `pg` into the server tree.
 *
 * A `vi.mock('pg')` is keyed by the resolved file. Without this alias a test of
 * the server mocks its own copy while the package's marker lookup imports the
 * root one, and the mock never reaches it.
 */
import { createRequire } from 'node:module';

export const serverPgEntry = createRequire(import.meta.url).resolve('pg');
