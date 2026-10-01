/**
 * Integer parameter validator — fail-loud helper for RSM tool handlers.
 *
 * #4002 transverse validation: NaN/0/negatives/floats used to silently produce
 * empty/broken results (Math.max(NaN,10)=NaN, slice(NaN,NaN)=[], etc.).
 * Schema-level minimum/maximum + this runtime guard ensure the input is a
 * finite integer within [min, max]. Anything else -> named error.
 */

export interface IntRange {
    readonly min: number;
    readonly max: number;
}

export interface SanitizeIntOptions {
    readonly min: number;
    readonly max: number;
    readonly fallback?: number;
}

export interface SanitizeIntSuccess {
    readonly ok: true;
    readonly value: number;
}

export interface SanitizeIntFailure {
    readonly ok: false;
    readonly error: string;
}

export type SanitizeIntResult = SanitizeIntSuccess | SanitizeIntFailure;

/**
 * Validate `value` against the bounded integer range [min, max].
 * - Accepts plain JS numbers only.
 * - Rejects NaN, ±Infinity, non-integers (including floats like 1.5), and out-of-range.
 * - If `value === undefined` or null and `fallback` is provided, returns fallback
 *   clamped to [min, max]. Without a fallback, undefined returns an error.
 * - Throws nothing — returns a discriminated union so the handler can render
 *   `isError: true` with a clear message naming the parameter.
 */
export function sanitizeInt(
    name: string,
    value: unknown,
    options: SanitizeIntOptions
): SanitizeIntResult {
    const { min, max, fallback } = options;

    if (typeof value !== 'number' || !Number.isFinite(value)) {
        if (value === undefined || value === null) {
            if (fallback !== undefined) {
                return { ok: true, value: clamp(fallback, min, max) };
            }
            return {
                ok: false,
                error: `${name} is required (number in [${min}, ${max}])`
            };
        }
        return {
            ok: false,
            error: `${name} must be a finite number (got ${String(value)}); expected integer in [${min}, ${max}]`
        };
    }

    if (!Number.isInteger(value)) {
        return {
            ok: false,
            error: `${name} must be an integer (got ${value}); expected integer in [${min}, ${max}]`
        };
    }

    if (value < min || value > max) {
        return {
            ok: false,
            error: `${name} must be in [${min}, ${max}] (got ${value})`
        };
    }

    return { ok: true, value };
}

function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

/**
 * Validate a semver-shaped version string: digits separated by dots, with no
 * leading 'v' or trailing junk. Used by roosync_config apply to refuse inputs
 * like 'v2' or 'NaN.x.x' before parseInt.
 */
const SEMVER_RE = /^[0-9]+(\.[0-9]+)*$/;

export function isValidSemver(version: string): boolean {
    return SEMVER_RE.test(version);
}