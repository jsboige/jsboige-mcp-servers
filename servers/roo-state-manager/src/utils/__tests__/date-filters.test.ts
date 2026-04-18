/**
 * Tests pour date-filters (issue #1244 - Couche 2.1)
 */

import { describe, it, expect } from 'vitest';
import { parseFilterDate, isWithinDateRange } from '../date-filters.js';

describe('parseFilterDate', () => {
    it('devrait retourner null pour undefined', () => {
        expect(parseFilterDate(undefined)).toBeNull();
    });

    it('devrait retourner null pour null', () => {
        expect(parseFilterDate(null)).toBeNull();
    });

    it('devrait retourner null pour une chaine vide', () => {
        expect(parseFilterDate('')).toBeNull();
    });

    it('devrait parser une date ISO 8601 complète', () => {
        const result = parseFilterDate('2026-04-08T12:34:56Z');
        expect(result).not.toBeNull();
        expect(result?.toISOString()).toBe('2026-04-08T12:34:56.000Z');
    });

    it('devrait parser une date YYYY-MM-DD en ajoutant T00:00:00Z', () => {
        const result = parseFilterDate('2026-04-08');
        expect(result).not.toBeNull();
        expect(result?.toISOString()).toBe('2026-04-08T00:00:00.000Z');
    });

    it('devrait retourner null pour une date invalide', () => {
        expect(parseFilterDate('not-a-date')).toBeNull();
    });

    it('devrait retourner null pour une date malformée', () => {
        expect(parseFilterDate('2026-13-45')).toBeNull();
    });

    it('devrait gérer les dates avec fuseaux horaires', () => {
        const result = parseFilterDate('2026-04-08T12:34:56+02:00');
        expect(result).not.toBeNull();
        expect(result?.toISOString()).toContain('2026-04-08T10:34:56');
    });
});

describe('isWithinDateRange', () => {
    const baseTimestamp = '2026-04-08T12:00:00Z';

    it('devrait retourner true si aucune borne n\'est fournie', () => {
        expect(isWithinDateRange(baseTimestamp, null, null)).toBe(true);
    });

    it('devrait retourner true pour timestamp dans la plage', () => {
        const start = parseFilterDate('2026-04-01');
        const end = parseFilterDate('2026-04-30');
        expect(isWithinDateRange(baseTimestamp, start, end)).toBe(true);
    });

    it('devrait retourner false si timestamp avant startDate', () => {
        const start = parseFilterDate('2026-04-10');
        expect(isWithinDateRange(baseTimestamp, start, null)).toBe(false);
    });

    it('devrait retourner false si timestamp après endDate', () => {
        const end = parseFilterDate('2026-04-01');
        expect(isWithinDateRange(baseTimestamp, null, end)).toBe(false);
    });

    it('devrait inclure toute la journée pour endDate YYYY-MM-DD', () => {
        const end = parseFilterDate('2026-04-08');
        const lateSameDay = '2026-04-08T23:59:59Z';
        expect(isWithinDateRange(lateSameDay, null, end)).toBe(true);
    });

    it('devrait inclure toute la journée pour startDate YYYY-MM-DD', () => {
        const start = parseFilterDate('2026-04-08');
        const earlySameDay = '2026-04-08T00:00:00Z';
        expect(isWithinDateRange(earlySameDay, start, null)).toBe(true);
    });

    it('devrait retourner false pour timestamp absent avec borne fournie', () => {
        const start = parseFilterDate('2026-04-01');
        expect(isWithinDateRange(undefined, start, null)).toBe(false);
        expect(isWithinDateRange(null, start, null)).toBe(false);
        expect(isWithinDateRange('', start, null)).toBe(false);
    });

    it('devrait retourner false pour timestamp invalide avec borne fournie', () => {
        const start = parseFilterDate('2026-04-01');
        expect(isWithinDateRange('invalid-date', start, null)).toBe(false);
    });

    it('devrait gérer les bornes exactes (inclusives)', () => {
        const start = parseFilterDate('2026-04-08T12:00:00Z');
        const end = parseFilterDate('2026-04-08T12:00:00Z');
        expect(isWithinDateRange(baseTimestamp, start, end)).toBe(true);
    });

    it('devrait étendre endDate à fin de journée si heure = 00:00:00', () => {
        const end = parseFilterDate('2026-04-08');
        const justBeforeMidnight = '2026-04-08T23:59:59.999Z';
        expect(isWithinDateRange(justBeforeMidnight, null, end)).toBe(true);
    });

    it('devrait respecter l\'heure exacte si endDate a une heure spécifiée', () => {
        const end = parseFilterDate('2026-04-08T12:00:00Z');
        const justAfter = '2026-04-08T12:00:01Z';
        expect(isWithinDateRange(justAfter, null, end)).toBe(false);
    });

    it('devrait retourner true pour timestamp égal à startDate', () => {
        const start = parseFilterDate('2026-04-08T12:00:00Z');
        expect(isWithinDateRange(baseTimestamp, start, null)).toBe(true);
    });

    it('devrait retourner true pour timestamp égal à endDate (heure exacte)', () => {
        const end = parseFilterDate('2026-04-08T12:00:00Z');
        expect(isWithinDateRange(baseTimestamp, null, end)).toBe(true);
    });

    it('devrait gérer les dates avec fuseaux horaires différents', () => {
        const start = parseFilterDate('2026-04-08T00:00:00Z');
        const end = parseFilterDate('2026-04-08T23:59:59Z');
        const timestampWithTimezone = '2026-04-08T12:00:00+02:00';
        expect(isWithinDateRange(timestampWithTimezone, start, end)).toBe(true);
    });

    it('devrait retourner true si timestamp invalide sans bornes (pas de filtrage)', () => {
        expect(isWithinDateRange('not-a-date', null, null)).toBe(true);
    });
});
