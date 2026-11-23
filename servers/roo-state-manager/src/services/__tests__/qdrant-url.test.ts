/**
 * #4880: `localhost` in QDRANT_URL is dialled as the loopback literal, so a
 * cold connect never waits on getaddrinfo (libuv threadpool) — the path that
 * turned disk I/O into `fetch failed` / UND_ERR_CONNECT_TIMEOUT on ai-01.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const constructed: any[] = [];
vi.mock('@qdrant/js-client-rest', () => ({
    QdrantClient: vi.fn((config: any) => {
        constructed.push(config);
        return { config };
    }),
}));

import { effectiveQdrantUrl } from '../qdrant-url.js';
import { getQdrantClient, resetQdrantClient } from '../qdrant.js';

const saved = { url: process.env.QDRANT_URL, sw: process.env.QDRANT_LOOPBACK_LITERAL, key: process.env.QDRANT_API_KEY };

beforeEach(() => {
    delete process.env.QDRANT_LOOPBACK_LITERAL;
    process.env.QDRANT_API_KEY = 'test-key';
    constructed.length = 0;
    resetQdrantClient();
});

afterEach(() => {
    for (const [k, v] of [['QDRANT_URL', saved.url], ['QDRANT_LOOPBACK_LITERAL', saved.sw], ['QDRANT_API_KEY', saved.key]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    resetQdrantClient();
});

describe('effectiveQdrantUrl', () => {
    test.each([
        ['http://localhost:6333', 'http://127.0.0.1:6333'],
        ['http://localhost:6333/', 'http://127.0.0.1:6333/'],
        ['http://LOCALHOST:6333', 'http://127.0.0.1:6333'],
        ['https://localhost', 'https://127.0.0.1'],
        ['http://localhost:6333/prefix', 'http://127.0.0.1:6333/prefix'],
    ])('dials %s as %s', (raw, expected) => {
        expect(effectiveQdrantUrl(raw)).toBe(expected);
    });

    test.each([
        'http://10.0.0.5:6333',
        'http://127.0.0.1:6333',
        'https://qdrant.example.com',
        'http://localhost.example.com:6333',
        'http://mylocalhost:6333',
        'http://[::1]:6333',
    ])('leaves %s unchanged', (raw) => {
        expect(effectiveQdrantUrl(raw)).toBe(raw);
    });

    test('unset, empty and malformed values are returned as-is', () => {
        expect(effectiveQdrantUrl(undefined)).toBeUndefined();
        expect(effectiveQdrantUrl('')).toBe('');
        expect(effectiveQdrantUrl('not a url')).toBe('not a url');
    });

    test('kill switch QDRANT_LOOPBACK_LITERAL=0 keeps the configured name', () => {
        process.env.QDRANT_LOOPBACK_LITERAL = '0';
        expect(effectiveQdrantUrl('http://localhost:6333')).toBe('http://localhost:6333');
    });
});

describe('getQdrantClient dials the effective URL', () => {
    test('a localhost QDRANT_URL reaches the client as 127.0.0.1 (shared and extended clients)', () => {
        process.env.QDRANT_URL = 'http://localhost:6333';
        getQdrantClient();
        getQdrantClient({ timeoutMs: 60000 });
        expect(constructed).toHaveLength(2);
        expect(constructed.map(c => c.url)).toEqual(['http://127.0.0.1:6333', 'http://127.0.0.1:6333']);
    });

    test('a non-loopback QDRANT_URL is passed through untouched', () => {
        process.env.QDRANT_URL = 'https://qdrant.example.com';
        getQdrantClient();
        expect(constructed[0].url).toBe('https://qdrant.example.com');
    });

    test('kill switch: the configured name reaches the client', () => {
        process.env.QDRANT_URL = 'http://localhost:6333';
        process.env.QDRANT_LOOPBACK_LITERAL = '0';
        getQdrantClient();
        expect(constructed[0].url).toBe('http://localhost:6333');
    });
});
