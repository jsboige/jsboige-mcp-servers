/**
 * #4736 P4 review (ms#1782, blocker B1) — the ONE derivation of the ws-writer
 * identity.
 *
 * Before this helper, TWO paths each derived `machineId` on their own:
 *
 *  - the tool actions (index_code_ws, index_code_supplement) from
 *    `indexingState.machineId` — which the state manager itself derives as
 *    `rooSyncCfg?.machineId ?? (ROOSYNC_MACHINE_ID || 'local')`, LOWERCASED
 *    (mandatory on cluster seats);
 *  - the refresh loop in index.ts from raw `process.env.COMPUTERNAME` —
 *    UPPERCASE on Windows.
 *
 * The P3 sentinel compares writer strings EXACTLY (`previous.writer !== writer`
 * → throw), so on a real seat the loop's pass was refused every time
 * (`MYIA-WEB1:roo-extensions` !== `myia-web1:roo-extensions`) while the tests
 * stayed green — they injected the same literal on both sides, the same
 * blind-spot motif as #3279. One helper, used by both paths, closes it; the
 * env-equality test (ws-writer-identity.test.ts) builds both writers from the
 * env and asserts they are equal.
 *
 * Precedence: the STATE machineId (what the sentinel saw at bootstrap) >
 * ROOSYNC_MACHINE_ID > COMPUTERNAME > HOSTNAME > 'unknown-machine'. Every
 * candidate is lowercased — the sentinel is case-sensitive and env vars are
 * not. Dependency surface: `path` only (node builtin), so any module may
 * import it cheaply.
 */
import { basename } from 'path';

/**
 * The machine half of the writer identity. Exported separately because the
 * loop also uses it for its 'unknown-machine' refuse-to-start guard (an
 * unidentified host must not hold the host lease while every pass is refused).
 */
export function resolveWsMachineId(stateMachineId?: string | null): string {
    const candidates = [
        stateMachineId,
        process.env.ROOSYNC_MACHINE_ID,
        process.env.COMPUTERNAME,
        process.env.HOSTNAME,
    ];
    for (const candidate of candidates) {
        const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
        if (trimmed) {
            return trimmed.toLowerCase();
        }
    }
    return 'unknown-machine';
}

/** The full writer string the sentinel compares: `<machine>:<workspace basename>`. */
export function resolveWsWriterIdentity(workspaceRoot: string, stateMachineId?: string | null): string {
    return `${resolveWsMachineId(stateMachineId)}:${basename(workspaceRoot)}`;
}
