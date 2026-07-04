/**
 * Coverage tests pour error-format — branches froides / pins défensifs
 *
 * Le base test (error-format.test.ts, 245 LOC) est très exhaustif : types
 * primitifs, subclasses, env mutation, CRLF, empty lines. Ce fichier pince
 * les branches résiduelles que la base n'atteint pas :
 *
 * - formatErrorForResponse L19 `instanceof Error` court-circuit : base ne
 *   teste jamais MCP_INCLUDE_STACKS=1 AVEC un non-Error. La 2e condition du
 *   AND (instanceof) est false → msg seul. Pin : le flag est ignoré pour
 *   les non-Error (String(error) n'a pas de stack).
 * - formatErrorForResponse L19 strict `=== '1'` : base teste '0' mais pas
 *   les valeurs truthy non-'1' ('true', 'yes', 'TRUE', ' 1', '1.0').
 * - formatErrorForLog L39 slice(0,3) boundary : base teste 4 lignes (exclut
 *   idx 3) et 2 lignes, jamais exactement 3 (toutes conservées).
 * - formatErrorForLog stack = '' (empty falsy) : base teste undefined, jamais
 *   empty string → ''.split('\n') = [''] → slice = [''] → join = ''.
 * - formatErrorForLog TypeError/RangeError avec stack : base teste le message
 *   des subclasses mais pas la truncation stack sur eux.
 * - formatErrorForLog stack 1 ligne : join sans separator ' | '.
 * - formatErrorForLog return shape {message, stack} toujours (stack=undefined
 *   pour non-Error, jamais absent).
 *
 * @module utils/__tests__/error-format.coverage.test
 * @see #833 C3
 * @version 1.0.0
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { formatErrorForResponse, formatErrorForLog } from '../error-format.js';

// ─────────────────── tests ───────────────────

describe('error-format.coverage', () => {
	const originalEnv = process.env.MCP_INCLUDE_STACKS;

	beforeEach(() => {
		delete process.env.MCP_INCLUDE_STACKS;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.MCP_INCLUDE_STACKS = originalEnv;
		} else {
			delete process.env.MCP_INCLUDE_STACKS;
		}
	});

	// ============================================================
	// formatErrorForResponse — L19 instanceof court-circuit [COLD]
	// ============================================================
	describe('formatErrorForResponse — MCP_INCLUDE_STACKS=1 + non-Error [COLD]', () => {
		test('string error + MCP_INCLUDE_STACKS=1 → msg seul (instanceof false)', () => {
			// L19 : env==='1' (true) && error instanceof Error (FALSE pour string)
			// → court-circuite && → return msg. Pin : flag ignoré pour non-Error.
			process.env.MCP_INCLUDE_STACKS = '1';
			expect(formatErrorForResponse('string error')).toBe('string error');
			expect(formatErrorForResponse('string error')).not.toContain('Stack:');
		});

		test('number 42 + MCP_INCLUDE_STACKS=1 → "42" seul', () => {
			process.env.MCP_INCLUDE_STACKS = '1';
			expect(formatErrorForResponse(42)).toBe('42');
		});

		test('null + MCP_INCLUDE_STACKS=1 → "null" seul', () => {
			process.env.MCP_INCLUDE_STACKS = '1';
			expect(formatErrorForResponse(null)).toBe('null');
		});

		test('undefined + MCP_INCLUDE_STACKS=1 → "undefined" seul', () => {
			process.env.MCP_INCLUDE_STACKS = '1';
			expect(formatErrorForResponse(undefined)).toBe('undefined');
		});

		test('plain object + MCP_INCLUDE_STACKS=1 → "[object Object]" seul', () => {
			// Même si l'objet a une propriété stack, instanceof Error = false.
			process.env.MCP_INCLUDE_STACKS = '1';
			const obj = { message: 'x', stack: 'fake stack' };
			expect(formatErrorForResponse(obj)).toBe('[object Object]');
			expect(formatErrorForResponse(obj)).not.toContain('Stack:');
		});

		test('Error instance + MCP_INCLUDE_STACKS=1 + stack → format complet (contrôle)', () => {
			// Contrôle : Error VRAI active bien le format stack.
			process.env.MCP_INCLUDE_STACKS = '1';
			const err = new Error('real');
			err.stack = 'Error: real\n    at a.js:1:1';
			const result = formatErrorForResponse(err);
			expect(result).toContain('Stack:');
			expect(result).toContain('at a.js:1:1');
		});
	});

	// ============================================================
	// formatErrorForResponse — L19 strict === '1' [COLD]
	// ============================================================
	describe('formatErrorForResponse — strict === "1" (valeurs truthy non-"1") [COLD]', () => {
		test('MCP_INCLUDE_STACKS="true" → msg seul (pas === "1")', () => {
			process.env.MCP_INCLUDE_STACKS = 'true';
			const err = new Error('test');
			err.stack = 'Error: test\n    at a.js:1:1';
			expect(formatErrorForResponse(err)).toBe('test');
			expect(formatErrorForResponse(err)).not.toContain('Stack:');
		});

		test('MCP_INCLUDE_STACKS="yes" → msg seul', () => {
			process.env.MCP_INCLUDE_STACKS = 'yes';
			const err = new Error('test');
			err.stack = 'Error: test\n    at a.js:1:1';
			expect(formatErrorForResponse(err)).toBe('test');
		});

		test('MCP_INCLUDE_STACKS="TRUE" (uppercase) → msg seul', () => {
			process.env.MCP_INCLUDE_STACKS = 'TRUE';
			const err = new Error('test');
			err.stack = 'Error: test\n    at a.js:1:1';
			expect(formatErrorForResponse(err)).toBe('test');
		});

		test('MCP_INCLUDE_STACKS=" 1" (leading space) → msg seul', () => {
			process.env.MCP_INCLUDE_STACKS = ' 1';
			const err = new Error('test');
			err.stack = 'Error: test\n    at a.js:1:1';
			expect(formatErrorForResponse(err)).toBe('test');
		});

		test('MCP_INCLUDE_STACKS="1.0" → msg seul', () => {
			process.env.MCP_INCLUDE_STACKS = '1.0';
			const err = new Error('test');
			err.stack = 'Error: test\n    at a.js:1:1';
			expect(formatErrorForResponse(err)).toBe('test');
		});

		test('MCP_INCLUDE_STACKS="2" → msg seul', () => {
			process.env.MCP_INCLUDE_STACKS = '2';
			const err = new Error('test');
			err.stack = 'Error: test\n    at a.js:1:1';
			expect(formatErrorForResponse(err)).toBe('test');
		});

		test('MCP_INCLUDE_STACKS="" (empty) → msg seul', () => {
			// Empty string est falsy et pas === '1'.
			process.env.MCP_INCLUDE_STACKS = '';
			const err = new Error('test');
			err.stack = 'Error: test\n    at a.js:1:1';
			expect(formatErrorForResponse(err)).toBe('test');
		});

		test('MCP_INCLUDE_STACKS="1" (exact) → stack inclus (contrôle positif)', () => {
			process.env.MCP_INCLUDE_STACKS = '1';
			const err = new Error('test');
			err.stack = 'Error: test\n    at a.js:1:1';
			expect(formatErrorForResponse(err)).toContain('Stack:');
		});
	});

	// ============================================================
	// formatErrorForLog — L39 slice(0,3) boundary [COLD]
	// ============================================================
	describe('formatErrorForLog — slice(0,3) boundary [COLD]', () => {
		test('stack exactement 3 lignes → toutes conservées (slice(0,3) inclusif)', () => {
			// Base teste 4 lignes (exclut idx 3) et 2 lignes. Pin le boundary
			// 3 lignes : slice(0,3) = indices 0,1,2 → tout conservé.
			const err = new Error('three lines');
			err.stack = 'Error: three lines\n    at a.js:1:1\n    at b.js:2:2';
			const result = formatErrorForLog(err);
			expect(result.stack).toContain('three lines');
			expect(result.stack).toContain('at a.js:1:1');
			expect(result.stack).toContain('at b.js:2:2');
			// 3 lignes jointes par ' | ' (2 séparateurs)
			const sepCount = (result.stack!.match(/ \| /g) || []).length;
			expect(sepCount).toBe(2);
		});

		test('stack exactement 4 lignes → 4e ligne EXCLUE (slice(0,3) strict)', () => {
			const err = new Error('four lines');
			err.stack =
				'Error: four lines\n    at a.js:1:1\n    at b.js:2:2\n    at c.js:3:3';
			const result = formatErrorForLog(err);
			expect(result.stack).toContain('at b.js:2:2');
			expect(result.stack).not.toContain('at c.js:3:3');
		});

		test('stack 1 ligne → join = ligne seule (pas de separator)', () => {
			// slice(0,3) sur 1 élément = [line] → join(' | ') = line (pas de ' | ').
			const err = new Error('one line');
			err.stack = 'Error: one line';
			const result = formatErrorForLog(err);
			expect(result.stack).toBe('Error: one line');
			expect(result.stack).not.toContain(' | ');
		});
	});

	// ============================================================
	// formatErrorForLog — stack empty string [COLD]
	// ============================================================
	describe('formatErrorForLog — stack empty string [COLD]', () => {
		test('stack = "" → "".split("\\n") = [""] → join = ""', () => {
			// Base teste stack=undefined (→ optional chain → undefined).
			// Pin stack='' (falsy mais string) → split marche → [''].
			const err = new Error('empty stack');
			err.stack = '' as any;
			const result = formatErrorForLog(err);
			expect(result.message).toBe('empty stack');
			expect(result.stack).toBe('');
		});

		test('stack = "" → typeof result.stack === "string" (pas undefined)', () => {
			// Pin la divergence avec stack=undefined qui donne stack=undefined.
			const err = new Error('x');
			err.stack = '' as any;
			const result = formatErrorForLog(err);
			expect(typeof result.stack).toBe('string');
		});

		test('stack = "   " (whitespace) → préservé tel quel', () => {
			const err = new Error('ws');
			err.stack = '   ' as any;
			const result = formatErrorForLog(err);
			expect(result.stack).toBe('   ');
		});
	});

	// ============================================================
	// formatErrorForLog — subclasses avec stack [COLD]
	// ============================================================
	describe('formatErrorForLog — subclasses stack truncation [COLD]', () => {
		test('TypeError avec stack multi-ligne → truncation s\'applique', () => {
			// Base teste TypeError.message mais pas le stack truncation.
			const err = new TypeError('not a function');
			err.stack = 'TypeError: not a function\n    at a.js:1:1\n    at b.js:2:2\n    at c.js:3:3';
			const result = formatErrorForLog(err);
			expect(result.message).toBe('not a function');
			expect(result.stack).toContain('at a.js:1:1');
			expect(result.stack).not.toContain('at c.js:3:3');
		});

		test('RangeError avec stack → truncation s\'applique', () => {
			const err = new RangeError('out of range');
			err.stack = 'RangeError: out of range\n    at x.js:1:1\n    at y.js:2:2\n    at z.js:3:3\n    at w.js:4:4';
			const result = formatErrorForLog(err);
			expect(result.stack).not.toContain('at z.js:3:3');
			expect(result.stack).not.toContain('at w.js:4:4');
		});

		test('custom Error subclass avec stack → instanceof Error true → truncation', () => {
			class CustomError extends Error {
				constructor(msg: string) {
					super(msg);
					this.name = 'CustomError';
				}
			}
			const err = new CustomError('custom');
			err.stack = 'CustomError: custom\n    at a.js:1:1\n    at b.js:2:2\n    at c.js:3:3\n    at d.js:4:4';
			const result = formatErrorForLog(err);
			expect(result.stack).not.toContain('at d.js:4:4');
		});
	});

	// ============================================================
	// formatErrorForLog — return shape {message, stack} [pin]
	// ============================================================
	describe('formatErrorForLog — return shape pinné', () => {
		test('Error → {message: string, stack: string|undefined}', () => {
			const err = new Error('test');
			err.stack = 'Error: test\n    at a.js:1:1';
			const result = formatErrorForLog(err);
			expect(result).toHaveProperty('message');
			expect(result).toHaveProperty('stack');
			expect(typeof result.message).toBe('string');
		});

		test('non-Error → stack === undefined (pas absent)', () => {
			// Pin : stack est toujours présent dans l'objet, undefined pour non-Error.
			const result = formatErrorForLog('string error');
			expect(result).toHaveProperty('stack');
			expect(result.stack).toBeUndefined();
			expect(result.message).toBe('string error');
		});

		test('null → {message: "null", stack: undefined}', () => {
			const result = formatErrorForLog(null);
			expect(result.message).toBe('null');
			expect(result.stack).toBeUndefined();
		});

		test('Error sans stack → {message, stack: undefined}', () => {
			const err = new Error('no stack');
			err.stack = undefined as any;
			const result = formatErrorForLog(err);
			expect(result.message).toBe('no stack');
			expect(result.stack).toBeUndefined();
		});
	});

	// ============================================================
	// formatErrorForResponse — return type toujours string [pin]
	// ============================================================
	describe('formatErrorForResponse — return type string pinné', () => {
		test('tous les inputs retournent un string', () => {
			// Pin le contrat : retour TOUJOURS string (pas undefined/null/number).
			expect(typeof formatErrorForResponse(new Error('x'))).toBe('string');
			expect(typeof formatErrorForResponse('str')).toBe('string');
			expect(typeof formatErrorForResponse(42)).toBe('string');
			expect(typeof formatErrorForResponse(null)).toBe('string');
			expect(typeof formatErrorForResponse(undefined)).toBe('string');
			expect(typeof formatErrorForResponse({})).toBe('string');
		});
	});

	// ============================================================
	// formatErrorForResponse — Error message vide
	// ============================================================
	describe('formatErrorForResponse — Error message vide [COLD]', () => {
		test('Error avec message="" → "" (pas de fallback)', () => {
			// Pin : pas de fallback sur un message générique si vide.
			expect(formatErrorForResponse(new Error(''))).toBe('');
		});

		test('Error avec message="" + MCP_INCLUDE_STACKS=1 → stack seul (msg vide)', () => {
			process.env.MCP_INCLUDE_STACKS = '1';
			const err = new Error('');
			err.stack = 'Error\n    at a.js:1:1';
			const result = formatErrorForResponse(err);
			// msg="" → format = "\n\nStack:\nError\n    at a.js:1:1"
			expect(result).toContain('Stack:');
			expect(result.startsWith('\n\nStack:')).toBe(true);
		});
	});

	// ============================================================
	// formatErrorForLog — stack avec tabs / formats exotiques [COLD]
	// ============================================================
	describe('formatErrorForLog — stack tabs/exotiques [COLD]', () => {
		test('stack avec tabs → préservé dans slice(0,3)', () => {
			const err = new Error('tabs');
			err.stack = 'Error: tabs\n\tat a.js:1:1\n\tat b.js:2:2\n\tat c.js:3:3';
			const result = formatErrorForLog(err);
			expect(result.stack).toContain('\tat a.js:1:1');
			expect(result.stack).not.toContain('\tat c.js:3:3');
		});

		test('stack avec 0 newline (1 token) → préservé', () => {
			const err = new Error('single');
			err.stack = 'just-one-token';
			const result = formatErrorForLog(err);
			expect(result.stack).toBe('just-one-token');
		});
	});
});
