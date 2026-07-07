/**
 * Per-read timeout guard for GDrive-backed shared-state reads.
 *
 * On GDrive Files On-Demand (the RooSync shared-state backing store), a file
 * whose content is "cloud-only" makes `fs.readFile`/`fs.copyFile` block while
 * GDrive tries to fetch it — observed hanging past the 120s MCP tool timeout
 * and wedging the caller (cf. #818 AttachmentManager, #2267 original). This
 * races the read against a timeout and resolves to `null` on timeout so the
 * caller can skip/throw instead of blocking forever.
 *
 * Extracted from AttachmentManager's local copy (#818) so MessageManager's
 * inbox-listing path can reuse it (same cloud-only hang class). AttachmentManager
 * can adopt this shared copy in a later cleanup — kept separate here to avoid
 * entangling with the unmerged #827 PR.
 *
 * @module utils/with-read-timeout
 */

/**
 * Race a promise against a timeout. Resolves to `null` on timeout (caller
 * decides whether to skip or throw), never rejects from the timeout side.
 *
 * @param promise The read promise to bound.
 * @param ms Timeout in milliseconds. On expiry the promise resolves `null`;
 *   the underlying read is NOT cancelled (a cloud-only read resolving later is
 *   simply ignored/GC'd) — this matches the #818 behavior.
 */
export function withReadTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    // `.unref()` so a hung read (timer the only pending work) doesn't keep a
    // short-lived process alive for `ms` — the timer still fires as long as the
    // event loop is alive (it just doesn't *keep* it alive). The `.finally`
    // clearTimeout below covers the resolved-before-timeout path.
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
