/**
 * Tests for secret-redaction utility (#3584)
 * @module utils/__tests__/secret-redaction
 */

import { describe, it, expect } from 'vitest';
import { redactKnownSecretValues } from '../secret-redaction.js';

/** Valeur de la fuite fondatrice #3584 : clé d'API nue, 64 hexadécimaux, sans nom. */
const LEAKED_KEY = '89ed6fb1'.padEnd(64, 'a1b2c3d4'.slice(0, 8));

/** SHA git de 40 hexadécimaux — le vocabulaire courant du canal, à NE PAS masquer. */
const GIT_SHA = 'a'.repeat(40);

describe('redactKnownSecretValues', () => {
    it('masque une valeur secrète NUE (le cas #3584 : aucun nom de variable)', () => {
        const env = { EMBEDDINGS_API_KEY: LEAKED_KEY };
        const out = redactKnownSecretValues(`clé active : ${LEAKED_KEY} (fin)`, env);

        expect(out).not.toContain(LEAKED_KEY);
        expect(out).toContain('<redacted:EMBEDDINGS_API_KEY>');
    });

    it("ne masque PAS un SHA git — il n'est pas une valeur secrète connue", () => {
        const env = { EMBEDDINGS_API_KEY: LEAKED_KEY };
        const text = `build/index.js mtime, commit ${GIT_SHA} sur main`;

        expect(redactKnownSecretValues(text, env)).toBe(text);
    });

    it('masque toutes les occurrences, pas seulement la première', () => {
        const env = { VLLM_API_KEY_MEDIUM: LEAKED_KEY };
        const out = redactKnownSecretValues(`${LEAKED_KEY} puis ${LEAKED_KEY}`, env);

        expect(out).toBe('<redacted:VLLM_API_KEY_MEDIUM> puis <redacted:VLLM_API_KEY_MEDIUM>');
    });

    it('ignore une valeur trop courte pour être un secret (anti-mutilation du texte)', () => {
        // `PASSWORD=dev` masquerait chaque « dev » du canal — la borne de longueur
        // est ce qui l'empêche.
        const env = { DB_PASSWORD: 'dev' };
        const text = 'la lane dev a livré sur dev';

        expect(redactKnownSecretValues(text, env)).toBe(text);
    });

    it("ignore une variable dont le NOM ne désigne pas un secret", () => {
        const env = { ANTHROPIC_BASE_URL: 'https://proxy.internal.example/v1' };
        const text = 'endpoint https://proxy.internal.example/v1 configuré';

        expect(redactKnownSecretValues(text, env)).toBe(text);
    });

    it('traite les métacaractères RegExp littéralement (base64 : +, /, =)', () => {
        const env = { GDRIVE_CLIENT_SECRET: 'a+b/c$d.e?f*g' };

        expect(redactKnownSecretValues('valeur = a+b/c$d.e?f*g', env))
            .toBe('valeur = <redacted:GDRIVE_CLIENT_SECRET>');
    });

    it('ne laisse aucun fragment quand une valeur courte préfixe une valeur longue', () => {
        // Masquer la courte d'abord laisserait le reliquat de la longue en clair.
        const short = 'abcdefgh';
        const long = 'abcdefghijklmnop';
        const env = { SHORT_TOKEN: short, LONG_TOKEN: long };
        const out = redactKnownSecretValues(`clé ${long}`, env);

        expect(out).not.toContain('ijklmnop');
        expect(out).not.toContain(short);
    });

    it('dédoublonne par valeur (deux variables portant le même secret)', () => {
        const env = { A_API_KEY: LEAKED_KEY, A_KEY: LEAKED_KEY };
        const out = redactKnownSecretValues(LEAKED_KEY, env);

        expect(out).toMatch(/^<redacted:A_(API_)?KEY>$/);
    });

    it('laisse intact un texte sans secret', () => {
        const env = { EMBEDDINGS_API_KEY: LEAKED_KEY };
        const text = 'aucun secret ici, juste du texte';

        expect(redactKnownSecretValues(text, env)).toBe(text);
    });

    it('tolère un texte vide ou indéfini sans lever', () => {
        const env = { EMBEDDINGS_API_KEY: LEAKED_KEY };

        expect(redactKnownSecretValues('', env)).toBe('');
        expect(redactKnownSecretValues(undefined as unknown as string, env)).toBeUndefined();
    });

    it("ne publie jamais la valeur dans le remplacement — seulement le nom", () => {
        const env = { EMBEDDINGS_API_KEY: LEAKED_KEY };
        const out = redactKnownSecretValues(LEAKED_KEY, env);

        expect(out).not.toContain(LEAKED_KEY);
        expect(out).not.toContain(LEAKED_KEY.slice(0, 8));
    });
});
