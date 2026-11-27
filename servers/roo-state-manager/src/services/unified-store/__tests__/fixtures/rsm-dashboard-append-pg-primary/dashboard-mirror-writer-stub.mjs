/**
 * #4596 — test double of the SERVED `services/unified-store/dashboard-mirror-writer.js`.
 *
 * The verdict ITSELF (unset → `myia-ai-01`, explicit seat, `*`, case folding,
 * call-time read, `COMPUTERNAME` → `HOSTNAME`) is pinned against the REAL
 * module by `roosync-dashboard-reconcile-mirror-writer.test.ts`. This double
 * exists to pin what the CLI does with the answer: consult the served module on
 * the PG-success path, publish no file when it says no, and keep the previous
 * behaviour when the module is absent (pre-#4596 build — the harness simply
 * does not copy this file in that scenario).
 *
 * The harness drives the verdict with `RSM_APPEND_TEST_MIRROR_DESIGNATED`
 * (`0` = this seat is not the writer). `dashboardMirrorWriter()` and
 * `MIRROR_WRITER_ENV` feed the machine-readable reason.
 */
export const MIRROR_WRITER_ENV = 'ROOSYNC_DASHBOARD_MIRROR_WRITER';
export const MIRROR_WRITER_DEFAULT = 'myia-ai-01';
export const MIRROR_WRITER_ALL = '*';

export function dashboardMirrorWriter() {
  const raw = (process.env[MIRROR_WRITER_ENV] ?? '').trim();
  return raw === '' ? MIRROR_WRITER_DEFAULT : raw;
}

export function mirrorWriterMachineId() {
  return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown';
}

export function isDesignatedMirrorWriter() {
  return process.env.RSM_APPEND_TEST_MIRROR_DESIGNATED !== '0';
}
