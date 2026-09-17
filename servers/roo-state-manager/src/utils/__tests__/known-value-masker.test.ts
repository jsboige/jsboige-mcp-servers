/**
 * #3584 §5.2 — filtre de nom de la couche valeur connue.
 *
 * L'élargissement est CIBLÉ (DSN/URI de connexion à credentials), pas générique
 * `URL|URI|DSN` : `HUB_URL`, `SEARXNG_URL`… sont des endpoints PUBLICS — le
 * vocabulaire courant du canal de coordination. Les attraper par valeur mutilerait
 * toute mention du hub dans les dashboards. Ces tests pinent la frontière dans les
 * deux sens.
 *
 * Valeurs fictives uniquement — jamais une credential réelle.
 */

import { describe, it, expect } from 'vitest';
import { createKnownValueMasker, redactKnownSecretValues } from '../known-value-masker.js';

const PG_URI = 'postgresql://svc:fictiti0us@db.internal:5433/unified_store';
const HUB = 'http://192.168.0.50:3000';

describe('known-value-masker — filtre de nom ciblé (#3584 §5.2)', () => {
  it('masks connection URIs held under *_URL/_DSN/CONN_STRING names', () => {
    const mask = createKnownValueMasker({
      UNIFIED_STORE_PG_URL: PG_URI,
      DATABASE_URL: 'postgres://other:fictiti0us@db2:5432/app',
      MYSQL_DSN: 'mysql://u:fictiti0us@mysql:3306/app',
      RABBITMQ_URL: 'amqp://guest:fictiti0us@mq:5672/',
      CONNECTION_STRING: 'Server=db;User Id=svc;Password=fictiti0us;',
    });
    expect(mask(`store: ${PG_URI}, plus mysql://u:fictiti0us@mysql:3306/app`))
      .not.toContain('fictiti0us');
  });

  it('does NOT mask public endpoints (HUB_URL, SEARXNG_URL, GLM_INGRESS_URL)', () => {
    const mask = createKnownValueMasker({
      HUB_URL: HUB,
      SEARXNG_URL: 'http://localhost:8888/search',
      GLM_INGRESS_URL: 'http://192.168.0.50:3000/v1',
      ROOSYNC_SHARED_PATH: 'C:/sync',
    });
    const text = `hub reachable at ${HUB}, search at http://localhost:8888/search`;
    expect(mask(text)).toBe(text);
  });

  it('keeps the base allowlist (API_KEY/TOKEN/PASSWORD…)', () => {
    const mask = createKnownValueMasker({ QDRANT_API_KEY: 'qdrant-fictitious-key-1' });
    expect(mask('key: qdrant-fictitious-key-1')).toContain('<redacted:QDRANT_API_KEY>');
  });

  it('skips values under the length threshold', () => {
    const mask = createKnownValueMasker({ DATABASE_URL: 'pgshort' }); // 7 chars < 8
    const text = 'short value pgshort stays';
    expect(mask(text)).toBe(text);
  });

  it('masks the longest value first (prefix shadowing)', () => {
    const mask = createKnownValueMasker({
      PG_API_KEY: 'abcdefgh12345678',
      DB_DSN: 'abcdefgh12345678xyz', // contient la valeur courte comme préfixe
    });
    const out = mask('leak: abcdefgh12345678xyz');
    expect(out).not.toContain('abcdefgh12345678xyz');
    expect(out).toContain('<redacted:DB_DSN>');
  });

  it('passes through when env holds no qualifying secret', () => {
    const mask = createKnownValueMasker({ PATH: 'C:/bin', HOME: 'C:/Users/x' });
    expect(mask('nothing to see')).toBe('nothing to see');
  });

  it('redactKnownSecretValues keeps its no-op contract on empty text', () => {
    expect(redactKnownSecretValues('')).toBe('');
    expect(redactKnownSecretValues(undefined as unknown as string)).toBe(undefined);
  });
});
