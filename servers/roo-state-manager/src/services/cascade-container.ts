/**
 * #4427 PR3 — lecture LIVE du conteneur Claudish (état RUNNING et CONSUMER).
 *
 * RUNNING et CONSUMER ne sont pas la même question (spec, § Trois états) :
 *
 * - **RUNNING** = l'environnement que le conteneur a REÇU. Source :
 *   `/proc/1/environ` via `docker exec` (le plus fidèle), repli
 *   `docker inspect --format '{{json .Config.Env}}'`.
 * - **CONSUMER** = ce que le parseur de failover a ACCEPTÉ. Source :
 *   `docker logs` → `[Failover] configured=N armed=[…] auto=…`. Une valeur
 *   dégradée en silence n'est visible QUE là : un `configured` inférieur au
 *   nombre de rôles du payload vaut dérive, pas alignement.
 *
 * **Une lecture de conteneur seule n'est jamais une confirmation** : un
 * consommateur muet rend `consumer: null`, et le verdict de l'appelant doit
 * être `non couvert`, jamais « aligned ».
 *
 * Aucun nom de conteneur n'est lu depuis l'environnement : il est FOURNI par
 * l'appelant. `CLAUDISH_CONTAINER_NAME` fait partie des variables qui ne sont
 * jamais lues par l'instrument (spec, § Ce qui n'est JAMAIS lu).
 *
 * Seules les clés de cascade allow-listées sortent de ce module : le reste de
 * l'environnement (credentials, ports, upstreams) n'est jamais restitué.
 *
 * @module services/cascade-container
 */

import { spawnSync } from 'child_process';
import { extractCascadeEnv } from './cascade-sync.js';

/** Couverture d'une lecture de conteneur — `unreadable` n'est pas `missing`. */
export type CascadeContainerCoverage = 'ok' | 'empty' | 'missing' | 'unreadable';

/** Ligne du parseur de failover, telle qu'elle est émise au démarrage. */
export interface CascadeConsumerReading {
    configured: number;
    armed: string[];
    auto: string | null;
    /** Ligne brute, bornée à 400 caractères : c'est une preuve, pas un journal. */
    raw: string;
}

export interface CascadeContainerReading {
    coverage: CascadeContainerCoverage;
    /** Explication humaine — jamais vide quand la couverture n'est pas `ok`. */
    detail: string;
    /** UNIQUEMENT les variables de cascade allow-listées. */
    env: Record<string, string>;
    /** ISO 8601 du démarrage du conteneur (péremption), si lisible. */
    startedAt: string | null;
    /** `null` = consommateur muet — à lire comme « non couvert », jamais « aligned ». */
    consumer: CascadeConsumerReading | null;
    /** D'où vient l'environnement lu. */
    source: 'proc-1-environ' | 'inspect' | null;
}

/** Exécuteur injectable — les tests n'ont pas besoin d'un démon docker. */
export type CascadeCommandRun = (
    cmd: string,
    args: string[],
    timeoutMs: number,
) => { status: number | null; stdout: string; stderr: string; error?: string };

/** Exécuteur par défaut : `spawnSync`, sans shell, avec délai borné. */
export const defaultCascadeCommandRun: CascadeCommandRun = (cmd, args, timeoutMs) => {
    const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    return {
        status: result.status,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        error: result.error ? String((result.error as NodeJS.ErrnoException).code ?? result.error.message) : undefined,
    };
};

const DEFAULT_TIMEOUT_MS = 10_000;

/** Docker dit explicitement qu'il ne connaît pas l'objet — ce n'est pas une panne. */
const NOT_FOUND_RE = /no such (?:container|object)/i;

/** Ligne du parseur : `[Failover] configured=3 armed=[SONNET,OPUS] auto=1`. */
const CONSUMER_RE = /\[Failover\]\s*configured=(\d+)\s+armed=\[([^\]]*)\](?:\s+auto=(\S+))?/;

function parseEnvLines(lines: string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return env;
}

function parseConsumer(logText: string): CascadeConsumerReading | null {
    const match = CONSUMER_RE.exec(logText);
    if (!match) return null;
    const armed = match[2]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
    return {
        configured: Number.parseInt(match[1], 10),
        armed,
        auto: match[3] ?? null,
        raw: match[0].slice(0, 400),
    };
}

export interface ReadCascadeContainerArgs {
    /** Nom du conteneur, fourni par l'appelant. */
    container: string;
    run?: CascadeCommandRun;
    timeoutMs?: number;
}

/**
 * Lit l'état RUNNING d'un conteneur, et la ligne CONSUMER quand elle existe.
 *
 * Ne lève jamais : une lecture impossible est un VERDICT (`missing` /
 * `unreadable`), pas une exception qui ferait croire à un conteneur sain.
 */
export function readCascadeContainer(args: ReadCascadeContainerArgs): CascadeContainerReading {
    const run = args.run ?? defaultCascadeCommandRun;
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const container = (args.container ?? '').trim();
    const base: CascadeContainerReading = {
        coverage: 'missing',
        detail: '',
        env: {},
        startedAt: null,
        consumer: null,
        source: null,
    };

    if (!container) {
        return { ...base, detail: 'nom de conteneur absent — rien à lire (fourni par l’appelant, jamais déduit de l’environnement)' };
    }

    // 1) RUNNING — le plus fidèle d'abord : /proc/1/environ (NUL-séparé).
    const procRead = run('docker', ['exec', container, 'cat', '/proc/1/environ'], timeoutMs);
    let env: Record<string, string> = {};
    let source: CascadeContainerReading['source'] = null;
    let readFailure = '';

    if (procRead.status === 0 && procRead.stdout.trim() !== '') {
        env = parseEnvLines(procRead.stdout.split('\u0000').filter((s) => s !== ''));
        source = 'proc-1-environ';
    } else {
        readFailure = (procRead.stderr || procRead.error || '').trim();
        // 2) Repli : la config déclarée du conteneur (ce qui a été PASSÉ au create).
        const inspectRead = run('docker', ['inspect', '--format', '{{json .Config.Env}}', container], timeoutMs);
        if (inspectRead.status === 0) {
            try {
                const parsed = JSON.parse(inspectRead.stdout) as unknown;
                if (Array.isArray(parsed)) {
                    env = parseEnvLines(parsed.filter((v): v is string => typeof v === 'string'));
                    source = 'inspect';
                }
            } catch {
                readFailure = `inspect illisible — ${inspectRead.stdout.slice(0, 120)}`;
            }
        } else if (!readFailure) {
            readFailure = (inspectRead.stderr || inspectRead.error || '').trim();
        }
    }

    if (source === null) {
        const coverage: CascadeContainerCoverage = NOT_FOUND_RE.test(readFailure) ? 'missing' : 'unreadable';
        return {
            ...base,
            coverage,
            detail:
                coverage === 'missing'
                    ? `conteneur ${container} absent : ${readFailure || 'docker ne le connaît pas'}`
                    : `lecture impossible du conteneur ${container} : ${readFailure || 'docker n’a rien rendu'}`,
        };
    }

    const cascadeEnv = extractCascadeEnv(env);
    const startedAtRead = run('docker', ['inspect', '--format', '{{.State.StartedAt}}', container], timeoutMs);
    const startedAt =
        startedAtRead.status === 0 && startedAtRead.stdout.trim() !== '' ? startedAtRead.stdout.trim() : null;

    const logsRead = run('docker', ['logs', '--tail', '400', container], timeoutMs);
    const consumer = logsRead.status === 0 ? parseConsumer(`${logsRead.stdout}\n${logsRead.stderr}`) : null;

    if (Object.keys(cascadeEnv).length === 0) {
        return {
            ...base,
            coverage: 'empty',
            detail: `conteneur ${container} lisible (${source}) mais aucune variable de cascade`,
            startedAt,
            consumer,
            source,
        };
    }

    return {
        coverage: 'ok',
        detail: `conteneur ${container} lu (${source})`,
        env: cascadeEnv,
        startedAt,
        consumer,
        source,
    };
}
