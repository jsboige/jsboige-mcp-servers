/**
 * #4427 PR3 — tests de la lecture LIVE du conteneur Claudish.
 *
 * Ce que ces tests VERROUILLENT :
 *   - `docker exec … cat /proc/1/environ` est la source PRIVILÉGIÉE : c'est
 *     l'env que le conteneur a réellement reçu, pas celui du manifeste ;
 *   - le repli `docker inspect` sert quand `/proc/1/environ` est illisible ;
 *   - « no such container » = ABSENT, une erreur docker quelconque = ILLISIBLE
 *     — les deux ne se réparent pas de la même façon, les confondre ferait
 *     recréer un conteneur qui existe ;
 *   - seules les clés allow-listées sortent : une lecture ne peut pas exfiltrer
 *     un secret du siège vers un rapport ;
 *   - un consommateur muet rend `consumer: null` (non couvert), jamais un
 *     `configured: 0` implicite.
 *
 * Le runner est INJECTÉ : aucun démon docker n'est requis pour ces tests.
 *
 * @module services/__tests__/cascade-container
 */

import { describe, test, expect } from 'vitest';
import { readCascadeContainer, type CascadeCommandRun } from '../cascade-container.js';

type Result = { status: number | null; stdout: string; stderr: string; error?: string };

const RUNNING_ENV = {
    CLAUDISH_FAILOVER_SONNET: 'mistral@zai-glm-5-3>kc@k3',
    CLAUDISH_FAILOVER_HAIKU: 'vllm-myia@swift-1.5-27b!own>role:sonnet',
    CLAUDISH_FAILOVER_ACTIVE: 'haiku@myia-po-2024',
    CLAUDISH_FAILOVER_AUTO: '1',
    ANTHROPIC_API_KEY: 'sk-ant-should-never-surface',
    CLAUDISH_PROXY_KEY: 'proxy-secret',
    CLAUDISH_RELAY_PORT: '3914',
};

const STARTED_AT = '2026-10-30T04:00:00.000000000Z';

/** `docker exec cat /proc/1/environ` : NUL-séparé, avec un NUL final. */
function procEnviron(env: Record<string, string>): string {
    return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0';
}

function ok(stdout: string): Result {
    return { status: 0, stdout, stderr: '', error: null };
}

function fail(stderr: string): Result {
    return { status: 1, stdout: '', stderr, error: null };
}

/** Table de réponses docker, routée sur la sous-commande ET le gabarit `--format`. */
interface Handlers {
    proc?: Result;
    inspectEnv?: Result;
    inspectStarted?: Result;
    logs?: Result;
}

function runner(h: Handlers): CascadeCommandRun & { calls: string[][] } {
    const calls: string[][] = [];
    const run = (cmd: string, args: string[], _timeoutMs: number): Result => {
        calls.push([cmd, ...args]);
        if (args[0] === 'exec') return h.proc ?? fail('unexpected exec');
        if (args[0] === 'logs') return h.logs ?? fail('no log driver');
        if (args[0] === 'inspect') {
            const fmt = args[1] === '--format' ? args[2] : '';
            if (fmt.includes('StartedAt')) return h.inspectStarted ?? ok(STARTED_AT);
            return h.inspectEnv ?? fail('unexpected inspect');
        }
        return fail(`unexpected: ${args.join(' ')}`);
    };
    const withCalls = run as CascadeCommandRun & { calls: string[][] };
    withCalls.calls = calls;
    return withCalls;
}

describe('readCascadeContainer — RUNNING', () => {
    test('lit l’env du conteneur, filtre sur l’allow-list, et date le démarrage', () => {
        const run = runner({ proc: ok(procEnviron(RUNNING_ENV)) });
        const reading = readCascadeContainer({ container: 'claudish', run });

        expect(reading.coverage).toBe('ok');
        expect(reading.source).toBe('proc-1-environ');
        expect(reading.env).toEqual({
            CLAUDISH_FAILOVER_SONNET: 'mistral@zai-glm-5-3>kc@k3',
            CLAUDISH_FAILOVER_HAIKU: 'vllm-myia@swift-1.5-27b!own>role:sonnet',
            CLAUDISH_FAILOVER_ACTIVE: 'haiku@myia-po-2024',
            CLAUDISH_FAILOVER_AUTO: '1',
        });
        // Aucune clé hors cascade ne survit à la lecture.
        expect(JSON.stringify(reading)).not.toContain('sk-ant');
        expect(JSON.stringify(reading)).not.toContain('proxy-secret');
        expect(reading.startedAt).toBe(STARTED_AT);
    });

    test('MUTANT — /proc illisible : repli sur docker inspect', () => {
        const run = runner({
            proc: fail('cat: /proc/1/environ: Permission denied'),
            inspectEnv: ok(JSON.stringify(Object.entries(RUNNING_ENV).map(([k, v]) => `${k}=${v}`))),
        });
        const reading = readCascadeContainer({ container: 'claudish', run });
        expect(reading.coverage).toBe('ok');
        expect(reading.source).toBe('inspect');
        expect(reading.env.CLAUDISH_FAILOVER_AUTO).toBe('1');
        expect(run.calls.some((c) => c.includes('inspect'))).toBe(true);
    });

    test('« No such container » = ABSENT, jamais « illisible »', () => {
        const reading = readCascadeContainer({
            container: 'claudish',
            run: runner({ proc: fail('Error: No such container: claudish'), inspectEnv: fail('Error: No such object: claudish') }),
        });
        expect(reading.coverage).toBe('missing');
        expect(reading.detail).toMatch(/no such/i);
        expect(reading.env).toEqual({});
        expect(reading.consumer).toBeNull();
    });

    test('MUTANT — une erreur docker ordinaire est ILLISIBLE, jamais « absente »', () => {
        const daemonDown = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock';
        const reading = readCascadeContainer({
            container: 'claudish',
            run: runner({ proc: fail(daemonDown), inspectEnv: fail(daemonDown) }),
        });
        expect(reading.coverage).toBe('unreadable');
        expect(reading.detail).toMatch(/docker daemon/i);
    });

    test('un conteneur vivant mais sans env de cascade = VIDE, pas absent', () => {
        const reading = readCascadeContainer({
            container: 'claudish',
            run: runner({ proc: ok(procEnviron({ ANTHROPIC_API_KEY: 'sk-ant-x', PATH: '/usr/bin' })) }),
        });
        expect(reading.coverage).toBe('empty');
        expect(reading.env).toEqual({});
        expect(reading.startedAt).toBe(STARTED_AT);
    });

    test('un nom de conteneur vide reste missing et ne lit rien', () => {
        const run = runner({});
        const reading = readCascadeContainer({ container: '   ', run });
        expect(reading.coverage).toBe('missing');
        expect(reading.env).toEqual({});
        expect(run.calls).toHaveLength(0);
    });
});

describe('readCascadeContainer — CONSUMER (ce que le parseur a ACCEPTÉ)', () => {
    test('la ligne [Failover] des logs est lue : configured / armed / auto', () => {
        const reading = readCascadeContainer({
            container: 'claudish',
            run: runner({
                proc: ok(procEnviron(RUNNING_ENV)),
                logs: ok('boot…\n[Failover] configured=2 armed=[SONNET, HAIKU] auto=1\nready\n'),
            }),
        });
        expect(reading.consumer?.configured).toBe(2);
        expect(reading.consumer?.armed).toEqual(['SONNET', 'HAIKU']);
        expect(reading.consumer?.auto).toBe('1');
        // La preuve est la ligne RÉELLE, pas une reconstruction.
        expect(reading.consumer?.raw).toBe('[Failover] configured=2 armed=[SONNET, HAIKU] auto=1');
    });

    test('MUTANT — consommateur MUET : consumer null (non couvert), jamais configured=0', () => {
        const reading = readCascadeContainer({
            container: 'claudish',
            run: runner({ proc: ok(procEnviron(RUNNING_ENV)), logs: ok('listening on :3914\n') }),
        });
        expect(reading.coverage).toBe('ok');
        expect(reading.consumer).toBeNull();
    });

    test('des logs illisibles ne fabriquent pas un consommateur', () => {
        const reading = readCascadeContainer({
            container: 'claudish',
            run: runner({ proc: ok(procEnviron(RUNNING_ENV)), logs: fail('no log driver configured') }),
        });
        expect(reading.consumer).toBeNull();
        // RUNNING reste couvert : la perte porte sur CONSUMER, pas sur l'env.
        expect(reading.coverage).toBe('ok');
    });
});

/**
 * #4968 — un siège occupé ne se lit pas par la queue des logs.
 *
 * La ligne `[Failover]` n'est émise QU'UNE FOIS, au démarrage (~1,6 s après,
 * mesuré sur ai-01 le 29/10). Sur le hub, qui écrit ~500 lignes/min, elle
 * quitte la queue de 400 lignes en moins d'une minute : tout `confirm` rendu
 * ensuite lisait un consommateur « muet » qui avait parlé (verdict
 * `consumer-muted` sur un consommateur opérationnel).
 *
 * Ces tests rejouent le symptôme MESURÉ : 2 102 lignes au moment de la
 * lecture, ligne du parseur en 4ᵉ position.
 */
describe('readCascadeContainer — CONSUMER sur un siège occupé (#4968)', () => {
    /** La ligne réelle du 27/11 (po-2025), verbatim. */
    const FAILOVER_LINE =
        '2026-11-27T21:37:58.847Z [claudish] [Failover] configured=4 armed=[haiku@myia-po-2027→Swift 1.5 local (vllm-myia), sonnet@myia-po-2026→GPT-6.1 Terra (po-2025)] auto=on';

    const STARTED_AT_MS = Date.parse(STARTED_AT);
    const LINES_PER_MINUTE = 500;

    interface LogEntry {
        /** Horodatage de l'ENTRÉE de journal — ce que docker filtre. */
        at: number;
        text: string;
    }

    /** Journal d'un siège occupé : la ligne du parseur en 4ᵉ position, ~2 100 lignes ensuite. */
    function busySeatLog(failover: string | null, noise = 2_100, base = STARTED_AT_MS): LogEntry[] {
        const entries: LogEntry[] = [
            { at: base, text: '[claudish] proxy starting' },
            { at: base + 100, text: '[claudish] env loaded' },
            { at: base + 200, text: '[claudish] routes ready' },
        ];
        if (failover !== null) entries.push({ at: base + 1_600, text: failover });
        const step = 60_000 / LINES_PER_MINUTE;
        for (let i = 0; i < noise; i++) {
            entries.push({ at: base + 2_000 + i * step, text: `[claudish] POST /v1/messages 200 #${i}` });
        }
        return entries;
    }

    /**
     * Runner docker qui SAIT filtrer comme docker : queue (`--tail N`) et
     * fenêtre (`--since`/`--until`). Une queue qui ne sait pas filtrer
     * rendrait le test incapable de distinguer les deux lectures.
     */
    function busyRunner(
        log: LogEntry[],
        started: Result,
        windowFails = false,
    ): CascadeCommandRun & { calls: string[][] } {
        const calls: string[][] = [];
        const run = (cmd: string, args: string[], _timeoutMs: number): Result => {
            calls.push([cmd, ...args]);
            if (args[0] === 'exec') return ok(procEnviron(RUNNING_ENV));
            if (args[0] === 'inspect') {
                const fmt = args[1] === '--format' ? args[2] : '';
                if (fmt.includes('StartedAt')) return started;
                return fail('unexpected inspect');
            }
            if (args[0] === 'logs') {
                const tailAt = args.indexOf('--tail');
                if (tailAt !== -1) {
                    const n = Number.parseInt(args[tailAt + 1], 10);
                    return ok(log.slice(-n).map((e) => e.text).join('\n'));
                }
                const sinceAt = args.indexOf('--since');
                const untilAt = args.indexOf('--until');
                if (sinceAt === -1 || untilAt === -1) return fail('unexpected logs args');
                if (windowFails) return fail('Cannot connect to the Docker daemon');
                const since = Date.parse(args[sinceAt + 1]);
                const until = Date.parse(args[untilAt + 1]);
                const kept = log.filter((e) => e.at >= since && e.at <= until);
                return ok(kept.map((e) => e.text).join('\n'));
            }
            return fail(`unexpected: ${args.join(' ')}`);
        };
        const withCalls = run as CascadeCommandRun & { calls: string[][] };
        withCalls.calls = calls;
        return withCalls;
    }

    test('la fixture reproduit le symptôme mesuré : la queue de 400 lignes a perdu la ligne', () => {
        const log = busySeatLog(FAILOVER_LINE);
        const whole = log.map((e) => e.text).join('\n');
        const tail = log.slice(-400).map((e) => e.text).join('\n');
        expect(whole).toContain('[Failover] configured=4');
        expect(tail).not.toContain('[Failover] configured=');
    });

    test('la FENÊTRE de démarrage lit le parseur, que la queue avait perdu', () => {
        const run = busyRunner(busySeatLog(FAILOVER_LINE), ok(STARTED_AT));
        const reading = readCascadeContainer({ container: 'claudish', run });

        expect(reading.consumer?.configured).toBe(4);
        expect(reading.consumer?.auto).toBe('on');
        expect(reading.consumer?.armed).toEqual([
            'haiku@myia-po-2027→Swift 1.5 local (vllm-myia)',
            'sonnet@myia-po-2026→GPT-6.1 Terra (po-2025)',
        ]);
        // La lecture porte sur le DÉMARRAGE, pas sur la queue.
        // calls = [cmd, ...args] → ['docker','logs','--since',<début>,'--until',<fin>,<conteneur>]
        const logsCall = run.calls.find((c) => c[2] === '--since');
        expect(logsCall).toBeDefined();
        expect(logsCall?.[3]).toBe(STARTED_AT);
        expect(logsCall?.[5]).toBe('2026-10-30T04:02:00.000Z');
    });

    test('MUTANT — sans date de démarrage, la queue seule rend un consommateur MUET', () => {
        // Le même journal, lu en queue : la ligne du parseur est hors fenêtre.
        const run = busyRunner(busySeatLog(FAILOVER_LINE), fail('inspect indisponible'));
        const reading = readCascadeContainer({ container: 'claudish', run });

        expect(reading.startedAt).toBeNull();
        expect(reading.consumer).toBeNull();
        expect(run.calls.some((c) => c[2] === '--tail' && c[3] === '400')).toBe(true);
    });

    test('MUTANT — une date illisible retombe sur la queue (jamais une exception)', () => {
        const run = busyRunner(busySeatLog(FAILOVER_LINE), ok('pas-une-date'));
        const reading = readCascadeContainer({ container: 'claudish', run });

        expect(reading.coverage).toBe('ok');
        expect(run.calls.some((c) => c[2] === '--tail')).toBe(true);
        expect(run.calls.some((c) => c[2] === '--since')).toBe(false);
    });

    test('une fenêtre ILLISIBLE retombe sur la queue : la perte du mécanisme ne vaut pas muet', () => {
        // Conteneur démarré il y à peine : la ligne du parseur est DANS la queue aussi.
        const run = busyRunner(busySeatLog(FAILOVER_LINE, 20), ok(STARTED_AT), true);
        const reading = readCascadeContainer({ container: 'claudish', run });

        expect(reading.consumer?.configured).toBe(4);
        const logsCalls = run.calls.filter((c) => c[0] === 'docker' && c[1] === 'logs');
        expect(logsCalls).toHaveLength(2);
        expect(logsCalls[0][2]).toBe('--since');
        expect(logsCalls[1][2]).toBe('--tail');
    });

    test('MUTANT — une ligne du boot PRÉCÉDENT dans la queue ne vaut pas consommateur', () => {
        // `docker restart` conserve le journal : le boot d'avant a parlé, celui-ci est muet.
        const previousBoot: LogEntry[] = [{ at: STARTED_AT_MS - 60_000, text: FAILOVER_LINE }];
        const run = busyRunner([...previousBoot, ...busySeatLog(null, 20)], ok(STARTED_AT));
        const reading = readCascadeContainer({ container: 'claudish', run });

        // La fenêtre du boot COURANT est lisible et ne porte aucune ligne : muet.
        expect(reading.consumer).toBeNull();
        expect(run.calls.filter((c) => c[0] === 'docker' && c[1] === 'logs')).toHaveLength(1);
    });
});
