/**
 * Coverage tests pour date-filters — branches froides / défensives
 *
 * Le base test (date-filters.test.ts, 133 LOC) couvre les happy paths :
 * undefined/null/'', ISO valide, YYYY-MM-DD, timezone +02:00, inclusivité,
 * endOfDay midnight. Ce fichier pince les branches que la base n'atteint
 * jamais ou dont elle ne vérifie pas le comportement exact :
 *
 * - parseFilterDate L22 `includes('T')` : string avec 'T' MAIS invalide
 *   ('TOTO', 'T', 'T00:00') → Date invalide → null. La base ne teste que
 *   ISO-valide-avec-T et YYYY-MM-DD-sans-T.
 * - parseFilterDate L24-26 catch : UNREACHABLE — new Date() ne lève jamais
 *   (retourne Invalid Date, pas un throw). Dead code défensif.
 * - parseFilterDate timezone négative -05:00 (base = +02:00 seulement).
 * - parseFilterDate whitespace truthy ('   ') → null.
 * - isWithinDateRange L50 boundary `hours===0 && minutes===0` : ignore
 *   seconds ET ms. 'T00:00:01' (h0,m0,s1) → ENCORE étendu. 'T00:01:00' (m1)
 *   → PAS étendu. Base ne teste que 'T00:00:00' exact.
 * - isWithinDateRange borne Invalid Date (truthy, non-null) : n'entre pas
 *   L41 (`!invalidDate` = false), comparaisons ts < NaN = false.
 * - isWithinDateRange L56-58 catch : UNREACHABLE.
 * - isWithinDateRange falsy timestamp non-string (0) via coercicion `!`.
 * - isWithinDateRange negative timezone timestamp.
 * - parseFilterDate format retour exact (valeur Date constructible).
 *
 * @module utils/__tests__/date-filters.coverage.test
 * @see #833 C3
 * @version 1.0.0
 */

import { describe, test, expect } from 'vitest';
import { parseFilterDate, isWithinDateRange } from '../date-filters.js';

// ─────────────────── tests ───────────────────

describe('date-filters.coverage', () => {
  // ============================================================
  // parseFilterDate — includes('T') avec string invalide [COLD]
  // ============================================================
  describe('parseFilterDate — includes("T") avec invalide [COLD]', () => {
    test('"TOTO" contient "T" → new Date("TOTO") → Invalid → null', () => {
      // L22 : 'TOTO'.includes('T') = true → new Date('TOTO') as-is → Invalid.
      // Pin : la présence de 'T' ne garantit pas un parsing réussi.
      expect(parseFilterDate('TOTO')).toBeNull();
    });

    test('"T" seul (includes T true) → Invalid → null', () => {
      expect(parseFilterDate('T')).toBeNull();
    });

    test('"T00:00:00" (avec T mais pas date complète) → tente parsing → null', () => {
      // 'T00:00:00'.includes('T') = true → new Date('T00:00:00') → Invalid.
      expect(parseFilterDate('T00:00:00')).toBeNull();
    });

    test('"2026-04-08Tgarbage" (préfixe valide + garbage) → Invalid → null', () => {
      expect(parseFilterDate('2026-04-08Tgarbage')).toBeNull();
    });
  });

  // ============================================================
  // parseFilterDate — timezone négative (base = +02:00 seulement)
  // ============================================================
  describe('parseFilterDate — timezone négative [COLD]', () => {
    test('"-05:00" offset négatif → conversion UTC correcte', () => {
      // 12:00:00-05:00 = 17:00:00Z. Base ne teste que +02:00 (→ 10:34:56Z).
      const result = parseFilterDate('2026-04-08T12:00:00-05:00');
      expect(result).not.toBeNull();
      expect(result?.toISOString()).toBe('2026-04-08T17:00:00.000Z');
    });

    test('"-12:00" offset max négatif → conversion', () => {
      const result = parseFilterDate('2026-04-08T12:00:00-12:00');
      expect(result?.toISOString()).toBe('2026-04-09T00:00:00.000Z');
    });

    test('"+00:00" offset Zéro explicite', () => {
      const result = parseFilterDate('2026-04-08T12:00:00+00:00');
      expect(result?.toISOString()).toBe('2026-04-08T12:00:00.000Z');
    });
  });

  // ============================================================
  // parseFilterDate — whitespace + edge cases [COLD]
  // ============================================================
  describe('parseFilterDate — whitespace + edge [COLD]', () => {
    test('"   " (whitespace truthy) → append T00:00:00Z → Invalid → null', () => {
      // '   '.includes('T') = false → '   T00:00:00Z' → Invalid.
      // Pin : whitespace est truthy donc passe `!dateStr` mais parsing échoue.
      expect(parseFilterDate('   ')).toBeNull();
    });

    test('"0" (truthy string "0") → "0T00:00:00Z" → Invalid → null', () => {
      expect(parseFilterDate('0')).toBeNull();
    });

    test('date avec ms explicites → préservées', () => {
      const result = parseFilterDate('2026-04-08T12:00:00.123Z');
      expect(result?.toISOString()).toBe('2026-04-08T12:00:00.123Z');
    });

    test('retour est une vraie Date instance (constructible)', () => {
      const result = parseFilterDate('2026-04-08');
      expect(result).toBeInstanceOf(Date);
      expect(typeof result?.getTime()).toBe('number');
    });
  });

  // ============================================================
  // parseFilterDate — SKIP catch (L24-26) [evidence]
  // ============================================================
  describe('parseFilterDate — catch L24-26 [SKIP: unreachable]', () => {
    test('SKIP : new Date() ne throw jamais (retourne Invalid Date)', () => {
      // Evidence : la spec JS garantit que `new Date(str)` retourne un objet
      // Date invalide (getTime() = NaN) sans lever. Le try/catch L20-26 est
      // défense pure — le catch ne peut pas être atteint via l'API publique.
      // isNaN check L23 gère déjà le cas invalide AVANT tout throw théorique.
      // On vérifie juste que la fonction ne throw pas sur input hostile.
      const hostile = [
        null,
        undefined,
        '',
        'garbage',
        '{}',
        'function(){}',
        '[object Object]',
      ] as const;
      for (const h of hostile) {
        expect(() => parseFilterDate(h as any)).not.toThrow();
      }
    });
  });

  // ============================================================
  // isWithinDateRange — L50 boundary hours===0 && minutes===0
  // ============================================================
  describe('isWithinDateRange — L50 boundary (ignore seconds/ms) [COLD]', () => {
    test('endDate "T00:00:01" (h0,m0,s1) → ENCORE étendu à fin de journée', () => {
      // L50 : getUTCHours()===0 && getUTCMinutes()===0. Seconds/ms ignorés.
      // '00:00:01' = h0,m0,s1 → condition VRAIE → étendu à 23:59:59.999.
      // Pin : la vérification ne porte QUE sur hours+minutes.
      const end = parseFilterDate('2026-04-08T00:00:01Z');
      const lateSameDay = '2026-04-08T23:59:59Z';
      expect(isWithinDateRange(lateSameDay, null, end)).toBe(true);
    });

    test('endDate "T00:00:00.500" (ms non-nul) → étendu (ms ignoré)', () => {
      const end = parseFilterDate('2026-04-08T00:00:00.500Z');
      const lateSameDay = '2026-04-08T22:00:00Z';
      expect(isWithinDateRange(lateSameDay, null, end)).toBe(true);
    });

    test('endDate "T00:01:00" (m1) → PAS étendu → ts après 00:01 rejeté', () => {
      // minutes !== 0 → condition fausse → pas d'extension endOfDay.
      // endDate reste 00:01:00 → ts 22:00 > 00:01 → rejeté.
      const end = parseFilterDate('2026-04-08T00:01:00Z');
      const lateSameDay = '2026-04-08T22:00:00Z';
      expect(isWithinDateRange(lateSameDay, null, end)).toBe(false);
    });

    test('endDate "T01:00:00" (h1) → PAS étendu', () => {
      const end = parseFilterDate('2026-04-08T01:00:00Z');
      const lateSameDay = '2026-04-08T22:00:00Z';
      expect(isWithinDateRange(lateSameDay, null, end)).toBe(false);
    });

    test('endDate "T00:00:01" → ts pile à 00:00:01 inclus (≤ endOfDay étendu)', () => {
      // endOfDay étendu à 23:59:59.999 → 00:00:01 < ça → inclus.
      const end = parseFilterDate('2026-04-08T00:00:01Z');
      const ts = '2026-04-08T00:00:01Z';
      expect(isWithinDateRange(ts, null, end)).toBe(true);
    });
  });

  // ============================================================
  // isWithinDateRange — borne Invalid Date (truthy, non-null) [COLD]
  // ============================================================
  describe('isWithinDateRange — borne Invalid Date [COLD]', () => {
    test('start = Invalid Date (truthy) → n\'entre pas L41, comparaison NaN', () => {
      // new Date('garbage') est un objet Date truthy → !startDate = false.
      // L41 skippé. L42 timestamp fourni. L45 ts valide. L46 `ts < startDate`
      // où startDate.getTime() = NaN → ts < NaN = false → pas rejeté par start.
      const invalidStart = new Date('garbage');
      const ts = '2026-04-08T12:00:00Z';
      // Pin : borne invalide non-null ne filtre PAS (comportement défensif).
      expect(isWithinDateRange(ts, invalidStart, null)).toBe(true);
    });

    test('end = Invalid Date → L50 comparaison NaN → pas rejeté par end', () => {
      const invalidEnd = new Date('garbage');
      const ts = '2026-04-08T12:00:00Z';
      // L47 endDate truthy → L49 endOfDay = Invalid Date.
      // L50 getUTCHours() = NaN !== 0 → pas étendu.
      // L53 `ts > endOfDay` (NaN) = false → pas rejeté.
      expect(isWithinDateRange(ts, null, invalidEnd)).toBe(true);
    });

    test('start + end = Invalid Date → n\'entre pas L41 → true (défense)', () => {
      // Les deux bornes Invalid Date (truthy) → !start && !end = false → L41 skippé.
      // Mais timestamp valide passe tous les guards (comparaisons NaN = false).
      const invalidStart = new Date('garbage');
      const invalidEnd = new Date('garbage');
      const ts = '2026-04-08T12:00:00Z';
      expect(isWithinDateRange(ts, invalidStart, invalidEnd)).toBe(true);
    });

    test('start Invalid Date + timestamp absent → false (L42)', () => {
      // L41 skippé (start truthy). L42 `!timestamp` → return false.
      const invalidStart = new Date('garbage');
      expect(isWithinDateRange(undefined, invalidStart, null)).toBe(false);
    });
  });

  // ============================================================
  // isWithinDateRange — falsy timestamp non-string (L42 coercicion)
  // ============================================================
  describe('isWithinDateRange — falsy timestamp coercicion (L42)', () => {
    test('timestamp = 0 (falsy number) avec borne → false', () => {
      // `!0` = true → L42 return false. Pin coercicion truthy.
      const start = parseFilterDate('2026-04-01');
      expect(isWithinDateRange(0 as any, start, null)).toBe(false);
    });

    test('timestamp = false (falsy) avec borne → false', () => {
      const start = parseFilterDate('2026-04-01');
      expect(isWithinDateRange(false as any, start, null)).toBe(false);
    });

    test('timestamp = 0 SANS borne → true (L41)', () => {
      // !start && !end → true avant le check timestamp.
      expect(isWithinDateRange(0 as any, null, null)).toBe(true);
    });
  });

  // ============================================================
  // isWithinDateRange — timestamp negative timezone
  // ============================================================
  describe('isWithinDateRange — timestamp timezone négative [COLD]', () => {
    test('ts -05:00 dans plage UTC → conversion correcte', () => {
      // ts 12:00-05:00 = 17:00Z. Plage [08:00Z, 20:00Z] → inclus.
      const start = parseFilterDate('2026-04-08T08:00:00Z');
      const end = parseFilterDate('2026-04-08T20:00:00Z');
      const ts = '2026-04-08T12:00:00-05:00'; // = 17:00Z
      expect(isWithinDateRange(ts, start, end)).toBe(true);
    });

    test('ts -05:00 avant plage → rejeté', () => {
      const start = parseFilterDate('2026-04-08T18:00:00Z');
      const ts = '2026-04-08T12:00:00-05:00'; // = 17:00Z < 18:00Z
      expect(isWithinDateRange(ts, start, null)).toBe(false);
    });
  });

  // ============================================================
  // isWithinDateRange — SKIP catch (L56-58) [evidence]
  // ============================================================
  describe('isWithinDateRange — catch L56-58 [SKIP: unreachable]', () => {
    test('SKIP : new Date + getTime ne throwent jamais', () => {
      // Evidence : L44 `new Date(timestamp)` retourne Invalid Date (pas throw).
      // L45 `ts.getTime()` retourne NaN (pas throw). Le try/catch L43-58 est
      // défense pure — le catch ne peut être atteint. isNaN check L45 gère
      // l'invalidité. On vérifie juste que la fonction ne throw pas.
      const hostile = [null, undefined, '', 'garbage', 0, false] as const;
      const start = parseFilterDate('2026-04-01');
      for (const h of hostile) {
        expect(() => isWithinDateRange(h as any, start, null)).not.toThrow();
      }
    });
  });

  // ============================================================
  // isWithinDateRange — boundary strict < (L46) et > (L53)
  // ============================================================
  describe('isWithinDateRange — boundary strict < / > [pin]', () => {
    test('L46 : ts exactement === startDate → inclus (pas <)', () => {
      // ts < startDate = false pour l'égalité → pas rejeté.
      const start = parseFilterDate('2026-04-08T12:00:00Z');
      expect(isWithinDateRange('2026-04-08T12:00:00Z', start, null)).toBe(true);
    });

    test('L46 : ts 1ms avant startDate → rejeté', () => {
      const start = parseFilterDate('2026-04-08T12:00:00.001Z');
      expect(isWithinDateRange('2026-04-08T12:00:00.000Z', start, null)).toBe(false);
    });

    test('L53 : ts exactement === endDate (heure spécifiée) → inclus (pas >)', () => {
      // ts > endOfDay = false pour l'égalité → pas rejeté.
      const end = parseFilterDate('2026-04-08T12:00:00Z'); // h non-nul → pas étendu
      expect(isWithinDateRange('2026-04-08T12:00:00Z', null, end)).toBe(true);
    });

    test('L53 : ts 1ms après endDate (heure spécifiée) → rejeté', () => {
      const end = parseFilterDate('2026-04-08T12:00:00.000Z');
      expect(isWithinDateRange('2026-04-08T12:00:00.001Z', null, end)).toBe(false);
    });
  });

  // ============================================================
  // isWithinDateRange — combos start + end
  // ============================================================
  describe('isWithinDateRange — combos [COLD]', () => {
    test('start > end (plage inversée) → aucun ts inclus', () => {
      // start 10:00, end 08:00 → ts 09:00 < start (rejet) ET > end (rejet).
      // Pin : pas de validation que start <= end.
      const start = parseFilterDate('2026-04-08T10:00:00Z');
      const end = parseFilterDate('2026-04-08T08:00:00Z');
      expect(isWithinDateRange('2026-04-08T09:00:00Z', start, end)).toBe(false);
    });

    test('start > end mais ts avant start → rejeté par L46', () => {
      const start = parseFilterDate('2026-04-08T10:00:00Z');
      const end = parseFilterDate('2026-04-08T08:00:00Z');
      expect(isWithinDateRange('2026-04-08T07:00:00Z', start, end)).toBe(false);
    });

    test('start === end (même instant, heure spécifiée) → ts === inclus', () => {
      const start = parseFilterDate('2026-04-08T12:00:00Z');
      const end = parseFilterDate('2026-04-08T12:00:00Z');
      expect(isWithinDateRange('2026-04-08T12:00:00Z', start, end)).toBe(true);
    });
  });
});
