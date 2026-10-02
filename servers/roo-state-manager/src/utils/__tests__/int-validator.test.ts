/**
 * Tests for int-validator.ts (#4002).
 *
 * Coverage:
 *  - sanitizeInt: NaN, Infinity, float, negative, zero (when min > 0),
 *    out-of-range, valid in-range, undefined + fallback, undefined without fallback.
 *  - isValidDottedVersion: 'v2' rejected, 'NaN.x.x' rejected, '1.2.3' accepted, '1' accepted.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeInt, isValidDottedVersion } from '../int-validator.js';

describe('sanitizeInt', () => {
    it('accepts a valid integer within range', () => {
        const r = sanitizeInt('lines', 100, { min: 1, max: 1000 });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(100);
    });

    it('accepts boundary values (min and max inclusive)', () => {
        expect(sanitizeInt('x', 1, { min: 1, max: 10 }).ok).toBe(true);
        expect(sanitizeInt('x', 10, { min: 1, max: 10 }).ok).toBe(true);
    });

    it('rejects NaN', () => {
        const r = sanitizeInt('lines', Number.NaN, { min: 1, max: 1000 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/finite number/);
    });

    it('rejects Infinity and -Infinity', () => {
        expect(sanitizeInt('x', Number.POSITIVE_INFINITY, { min: 1, max: 100 }).ok).toBe(false);
        expect(sanitizeInt('x', Number.NEGATIVE_INFINITY, { min: 1, max: 100 }).ok).toBe(false);
    });

    it('rejects floats like 1.5', () => {
        const r = sanitizeInt('bucket', 1.5, { min: 1, max: 100 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/integer/);
    });

    it('rejects values below min', () => {
        const r = sanitizeInt('x', 0, { min: 1, max: 100 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/in \[1, 100\]/);
    });

    it('rejects values above max', () => {
        const r = sanitizeInt('x', 200, { min: 1, max: 100 });
        expect(r.ok).toBe(false);
    });

    it('rejects negative numbers when min >= 0', () => {
        const r = sanitizeInt('x', -5, { min: 0, max: 100 });
        expect(r.ok).toBe(false);
    });

    it('rejects strings', () => {
        const r = sanitizeInt('x', '50', { min: 1, max: 100 });
        expect(r.ok).toBe(false);
    });

    it('uses fallback when value is undefined', () => {
        const r = sanitizeInt('lines', undefined, { min: 1, max: 1000, fallback: 50 });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(50);
    });

    it('uses fallback when value is null', () => {
        const r = sanitizeInt('lines', null, { min: 1, max: 1000, fallback: 25 });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(25);
    });

    it('returns required error when undefined and no fallback', () => {
        const r = sanitizeInt('bucket', undefined, { min: 1, max: 100 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/required/);
    });

    it('clamps fallback below min up to min', () => {
        const r = sanitizeInt('x', undefined, { min: 10, max: 100, fallback: 5 });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(10);
    });

    it('clamps fallback above max down to max', () => {
        const r = sanitizeInt('x', undefined, { min: 1, max: 10, fallback: 99 });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(10);
    });
});

describe('isValidDottedVersion', () => {
    it('accepts bare integer', () => {
        expect(isValidDottedVersion('2')).toBe(true);
    });

    it('accepts dotted versions', () => {
        expect(isValidDottedVersion('1.2.3')).toBe(true);
        expect(isValidDottedVersion('1.0')).toBe(true);
        expect(isValidDottedVersion('10.20.30')).toBe(true);
    });

    it('rejects leading v (the original bug)', () => {
        expect(isValidDottedVersion('v2')).toBe(false);
        expect(isValidDottedVersion('V1.2.3')).toBe(false);
    });

    it('rejects NaN-shaped strings', () => {
        expect(isValidDottedVersion('NaN.x.x')).toBe(false);
        expect(isValidDottedVersion('NaN')).toBe(false);
    });

    it('rejects empty and whitespace', () => {
        expect(isValidDottedVersion('')).toBe(false);
        expect(isValidDottedVersion('  ')).toBe(false);
    });

    it('rejects trailing junk', () => {
        expect(isValidDottedVersion('1.2.3-beta')).toBe(false);
        expect(isValidDottedVersion('1.x')).toBe(false);
    });

    it('rejects trailing dot', () => {
        expect(isValidDottedVersion('1.2.')).toBe(false);
    });

    it('rejects leading dot', () => {
        expect(isValidDottedVersion('.1.2')).toBe(false);
    });
});