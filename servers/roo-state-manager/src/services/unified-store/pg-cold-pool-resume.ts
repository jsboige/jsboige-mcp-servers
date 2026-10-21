/**
 * Bounded resume for cold PG pools (#4303, #4291 lever 3).
 *
 * @module services/unified-store/pg-cold-pool-resume
 *
 * Measured on ai-01 (proxy.log, 20/10): every PG read failure after the
 * 11:13Z host restart — 5 replis between 11:15:22Z and 11:16:36Z, 82
 * dashboard + 8 channel over the full log — was a single
 * `Connection terminated due to connection timeout`. The read hit the pool
 * before its first connection completed, the read helper returned null, and
 * the caller reopened GDrive at the exact moment DriveFS was coldest.
 *
 * The resume is deliberately the SMALLEST of the two options the issue
 * allows (pool prewarm vs bounded read resume): one extra attempt, after a
 * short delay, logged — then the existing null → GDrive fallback contract
 * stands untouched for durable failures. Non-timeout errors (syntax, auth,
 * missing relation) do not heal on retry and are re-thrown immediately.
 */

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('pg-cold-pool-resume');

/**
 * node-postgres raises exactly this message when connectionTimeoutMillis
 * fires on pool.connect()/query() — the cold-pool signature measured in the
 * incident. Matched on the error string, case-insensitive; anything else is
 * not a cold pool and does not resume.
 */
export function isPgConnectionTimeout(error: unknown): boolean {
  return /connection terminated due to connection timeout/i.test(String(error));
}

/** Delay between the failed attempt and the single resume attempt. */
export const PG_COLD_RESUME_DELAY_MS = 250;

/**
 * Run a PG read with ONE bounded resume on a connection timeout.
 *
 * - first attempt fails with a non-timeout error → re-thrown (no retry)
 * - first attempt fails with a connection timeout → logged, short delay,
 *   exactly one more attempt
 * - the resume attempt's failure propagates untouched: the caller's
 *   existing catch does today's fallback (null → GDrive)
 */
export async function withColdPoolResume<T>(
  read: () => Promise<T>,
  context: string
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isPgConnectionTimeout(error)) throw error;
    logger.warn('[pg-resume] connection timeout (cold pool) — one bounded retry before GDrive fallback', {
      context,
      error: String(error),
    });
    await new Promise(resolve => setTimeout(resolve, PG_COLD_RESUME_DELAY_MS));
    return read();
  }
}
