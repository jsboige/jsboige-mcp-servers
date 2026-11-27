/**
 * #4596 — a BROKEN served module (independent review 27/11, web1).
 *
 * The module exists but does not carry the guard: the CLI's export check
 * throws, and the CLI must fail OPEN (the mirror is written, as before) while
 * SAYING SO — a broken artifact must not read like the deliberate "module
 * absent" case, which stays silent. The verdict itself is pinned against the
 * real module by `roosync-dashboard-reconcile-mirror-writer.test.ts`.
 */
export const MIRROR_WRITER_ENV = 'ROOSYNC_DASHBOARD_MIRROR_WRITER';
export const MIRROR_WRITER_DEFAULT = 'myia-ai-01';
export const MIRROR_WRITER_ALL = '*';

export function dashboardMirrorWriter() {
  const raw = (process.env[MIRROR_WRITER_ENV] ?? '').trim();
  return raw === '' ? MIRROR_WRITER_DEFAULT : raw;
}

export function mirrorWriterMachineId() {
  const configured = (process.env.ROOSYNC_MACHINE_ID ?? '').trim();
  if (configured !== '') return configured.toLowerCase();
  return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown';
}

// NO `isDesignatedMirrorWriter` — that is the point of this fixture.
