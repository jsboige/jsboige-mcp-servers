import { describe, it, expect } from 'vitest';
import { parseFilterDate, isWithinDateRange } from '../../../src/utils/date-filters.js';

describe('parseFilterDate', () => {
	it('should parse ISO 8601 full datetime', () => {
		const d = parseFilterDate('2026-04-08T12:34:56Z');
		expect(d).not.toBeNull();
		expect(d!.getUTCFullYear()).toBe(2026);
		expect(d!.getUTCMonth()).toBe(3); // April = 3
		expect(d!.getUTCDate()).toBe(8);
	});

	it('should parse YYYY-MM-DD as midnight UTC', () => {
		const d = parseFilterDate('2026-01-15');
		expect(d).not.toBeNull();
		expect(d!.getUTCFullYear()).toBe(2026);
		expect(d!.getUTCHours()).toBe(0);
	});

	it('should return null for undefined', () => {
		expect(parseFilterDate(undefined)).toBeNull();
	});

	it('should return null for null', () => {
		expect(parseFilterDate(null)).toBeNull();
	});

	it('should return null for empty string', () => {
		expect(parseFilterDate('')).toBeNull();
	});

	it('should return null for invalid date string', () => {
		expect(parseFilterDate('not-a-date')).toBeNull();
	});

	it('should parse date with timezone offset', () => {
		const d = parseFilterDate('2026-04-08T15:00:00+02:00');
		expect(d).not.toBeNull();
		expect(d!.getUTCHours()).toBe(13);
	});
});

describe('isWithinDateRange', () => {
	const start = parseFilterDate('2026-04-01');
	const end = parseFilterDate('2026-04-30');

	it('should return true when no bounds provided', () => {
		expect(isWithinDateRange('2026-04-15T12:00:00Z', null, null)).toBe(true);
	});

	it('should return true for timestamp within range', () => {
		expect(isWithinDateRange('2026-04-15T12:00:00Z', start, end)).toBe(true);
	});

	it('should return true for timestamp on start boundary', () => {
		expect(isWithinDateRange('2026-04-01T00:00:00Z', start, end)).toBe(true);
	});

	it('should return true for timestamp on end boundary (full day)', () => {
		expect(isWithinDateRange('2026-04-30T23:59:59Z', start, end)).toBe(true);
	});

	it('should return false for timestamp before start', () => {
		expect(isWithinDateRange('2026-03-31T23:59:59Z', start, end)).toBe(false);
	});

	it('should return false for timestamp after end', () => {
		expect(isWithinDateRange('2026-05-01T00:00:00Z', start, end)).toBe(false);
	});

	it('should return false for null timestamp when bounds exist', () => {
		expect(isWithinDateRange(null, start, end)).toBe(false);
	});

	it('should return false for undefined timestamp when bounds exist', () => {
		expect(isWithinDateRange(undefined, start, end)).toBe(false);
	});

	it('should return true for null timestamp when no bounds', () => {
		expect(isWithinDateRange(null, null, null)).toBe(true);
	});

	it('should filter with only start date', () => {
		expect(isWithinDateRange('2026-04-15T12:00:00Z', start, null)).toBe(true);
		expect(isWithinDateRange('2026-03-15T12:00:00Z', start, null)).toBe(false);
	});

	it('should filter with only end date', () => {
		expect(isWithinDateRange('2026-04-15T12:00:00Z', null, end)).toBe(true);
		expect(isWithinDateRange('2026-05-15T12:00:00Z', null, end)).toBe(false);
	});

	it('should return false for invalid timestamp string', () => {
		expect(isWithinDateRange('invalid', start, end)).toBe(false);
	});

	it('should extend end-of-day for YYYY-MM-DD end dates', () => {
		const endDay = parseFilterDate('2026-04-08');
		// 23:59:59 on the same day should be included
		expect(isWithinDateRange('2026-04-08T23:59:59Z', null, endDay)).toBe(true);
		// Next day midnight should be excluded
		expect(isWithinDateRange('2026-04-09T00:00:00Z', null, endDay)).toBe(false);
	});

	it('should not extend end-of-day for precise datetime end dates', () => {
		const endPrecise = parseFilterDate('2026-04-08T12:00:00Z');
		// 13:00 is after 12:00
		expect(isWithinDateRange('2026-04-08T13:00:00Z', null, endPrecise)).toBe(false);
	});
});
