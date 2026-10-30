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
