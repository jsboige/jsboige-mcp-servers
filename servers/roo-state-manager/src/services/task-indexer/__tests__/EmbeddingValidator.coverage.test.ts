/**
 * Coverage tests pour EmbeddingValidator — branches froides / pins défensifs
 *
 * Le base test (EmbeddingValidator.test.ts, 226 LOC) couvre les happy paths et
 * erreurs principales. Ce fichier pince les branches résiduelles :
 *
 * - validateVectorGlobal L16 `expectedDim ?? getEmbeddingDimensions()` : `??`
 *   (nullish) PAS `||`. expectedDim=0 (falsy, non-nullish) → dim=0 (pas 1536).
 *   Pin la divergence `??` vs `||` (si "modernisé" en ||, 0 deviendrait 1536).
 * - validateVectorGlobal L16 expectedDim=null → 1536 (null IS nullish).
 * - validateVectorGlobal L42 details divergence hasNaN/hasInfinity : base
 *   teste NaN (hasNaN=true) mais ne pinne jamais hasInfinity pour Infinity.
 *   Pour Infinity : hasNaN=false, hasInfinity=true.
 * - validateVectorGlobal L36 Number.isFinite boundary : -0/MAX_VALUE/EPSILON
 *   tous finis (acceptés).
 * - validateVectorGlobal L42 details exact pour mix NaN+Infinity simultanés.
 * - sanitizePayload L57-66 ordering : undefined sur special key (parent_task_id)
 *   retiré par L57 AVANT L60. Empty string sur special key → L64 retire.
 * - sanitizePayload payload hostile (null/undefined/array/primitive) :
 *   `{...null}` = {} (no crash). Base ne teste jamais.
 * - sanitizePayload shallow copy : nested undefined NOT cleaned.
 * - sanitizePayload special keys simultanés (parent_task_id + root_task_id).
 * - sanitizePayload L64 trim() : whitespace-only retiré.
 *
 * @module services/task-indexer/__tests__/EmbeddingValidator.coverage.test
 * @see #833 C3
 * @version 1.0.0
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateVectorGlobal, sanitizePayload } from '../EmbeddingValidator.js';
import { StateManagerError } from '../../../types/errors.js';

// Mock the openai module (same as base test)
vi.mock('../../../services/openai.js', () => ({
	getEmbeddingDimensions: vi.fn(() => 1536),
}));

// ─────────────────── tests ───────────────────

describe('EmbeddingValidator.coverage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ============================================================
	// validateVectorGlobal — L16 `??` (nullish) vs `||` [COLD]
	// ============================================================
	describe('validateVectorGlobal — L16 `??` nullish coalescing [COLD]', () => {
		test('expectedDim=0 (falsy, non-nullish) → dim=0 (PAS 1536)', () => {
			// Pin : `??` ne garde QUE null/undefined. 0 est falsy mais non-nullish
			// → dim=0. Si "modernisé" en `||`, 0 deviendrait 1536 (bug).
			// Vecteur vide (length 0) === dim 0 → valide (passe L26 length check).
			expect(() => validateVectorGlobal([], 0)).not.toThrow();
		});

		test('expectedDim=0 + vecteur non-vide → INVALID_VECTOR_DIMENSION', () => {
			// Confirme que dim=0 est bien utilisé (pas fallback 1536).
			expect(() => validateVectorGlobal([0.5], 0)).toThrow(
				StateManagerError
			);
			try {
				validateVectorGlobal([0.5], 0);
				expect.fail('Should throw');
			} catch (err: any) {
				expect(err.code).toBe('INVALID_VECTOR_DIMENSION');
				expect(err.details).toEqual({
					actualDimension: 1,
					expectedDimension: 0,
				});
			}
		});

		test('expectedDim=null → 1536 (null IS nullish → fallback)', () => {
			// null ?? getEmbeddingDimensions() = 1536.
			const vector = new Array(1536).fill(0.5);
			expect(() => validateVectorGlobal(vector, null as any)).not.toThrow();
		});

		test('expectedDim undefined (omis) → 1536 (default)', () => {
			const vector = new Array(1536).fill(0.5);
			expect(() => validateVectorGlobal(vector)).not.toThrow();
		});

		test('expectedDim=NaN (falsy-ish, non-nullish) → dim=NaN → length !== NaN', () => {
			// NaN ?? x = NaN (NaN n'est pas nullish). vector.length (1536) !== NaN
			// → true → INVALID_VECTOR_DIMENSION. Pin comportement NaN comme dim.
			expect(() => validateVectorGlobal(new Array(1536).fill(0.5), NaN)).toThrow(
				'Dimension invalide'
			);
		});
	});

	// ============================================================
	// validateVectorGlobal — L42 hasInfinity details [COLD]
	// ============================================================
	describe('validateVectorGlobal — L42 hasInfinity details [COLD]', () => {
		test('Infinity → details {hasNaN: false, hasInfinity: true}', () => {
			// Base teste NaN (hasNaN=true) mais ne pinne jamais hasInfinity.
			// Pour Infinity : Number.isNaN(Infinity)=false → hasNaN=false.
			// !Number.isFinite(Infinity)=true && !Number.isNaN(Infinity)=true → hasInfinity=true.
			const vector = new Array(1536).fill(0.5);
			vector[0] = Infinity;
			try {
				validateVectorGlobal(vector);
				expect.fail('Should throw');
			} catch (err: any) {
				expect(err.code).toBe('INVALID_VECTOR_VALUES');
				expect(err.details).toEqual({
					hasNaN: false,
					hasInfinity: true,
				});
			}
		});

		test('-Infinity → details {hasNaN: false, hasInfinity: true}', () => {
			const vector = new Array(1536).fill(0.5);
			vector[0] = -Infinity;
			try {
				validateVectorGlobal(vector);
				expect.fail('Should throw');
			} catch (err: any) {
				expect(err.details).toEqual({
					hasNaN: false,
					hasInfinity: true,
				});
			}
		});

		test('NaN → details {hasNaN: true, hasInfinity: false}', () => {
			// Pin complet pour NaN : hasInfinity=false car
			// !Number.isFinite(NaN)=true && !Number.isNaN(NaN)=false → hasInfinity=false.
			const vector = new Array(1536).fill(0.5);
			vector[0] = NaN;
			try {
				validateVectorGlobal(vector);
				expect.fail('Should throw');
			} catch (err: any) {
				expect(err.details).toEqual({
					hasNaN: true,
					hasInfinity: false,
				});
			}
		});

		test('mix NaN + Infinity simultanés → {hasNaN: true, hasInfinity: true}', () => {
			// Pin le cas mixte : les deux flags true simultanément.
			const vector = new Array(1536).fill(0.5);
			vector[0] = NaN;
			vector[1] = Infinity;
			try {
				validateVectorGlobal(vector);
				expect.fail('Should throw');
			} catch (err: any) {
				expect(err.details).toEqual({
					hasNaN: true,
					hasInfinity: true,
				});
			}
		});
	});

	// ============================================================
	// validateVectorGlobal — L36 Number.isFinite boundary [COLD]
	// ============================================================
	describe('validateVectorGlobal — L36 Number.isFinite boundary [COLD]', () => {
		test('-0 (negative zero) → finite → accepté', () => {
			// Number.isFinite(-0) = true. Pin que -0 est valide.
			const vector = new Array(1536).fill(-0);
			expect(() => validateVectorGlobal(vector)).not.toThrow();
		});

		test('Number.MAX_VALUE → finite → accepté', () => {
			const vector = new Array(1536).fill(Number.MAX_VALUE);
			expect(() => validateVectorGlobal(vector)).not.toThrow();
		});

		test('Number.MIN_VALUE (smallest positive) → finite → accepté', () => {
			const vector = new Array(1536).fill(Number.MIN_VALUE);
			expect(() => validateVectorGlobal(vector)).not.toThrow();
		});

		test('Number.EPSILON → finite → accepté', () => {
			const vector = new Array(1536).fill(Number.EPSILON);
			expect(() => validateVectorGlobal(vector)).not.toThrow();
		});

		test('MAX_SAFE_INTEGER → finite → accepté', () => {
			const vector = new Array(1536).fill(Number.MAX_SAFE_INTEGER);
			expect(() => validateVectorGlobal(vector)).not.toThrow();
		});

		test('integer values (not just floats) → accepté', () => {
			// Pin que les entiers sont valides (Qdrant accepte int/float).
			const vector = new Array(1536).fill(1);
			expect(() => validateVectorGlobal(vector)).not.toThrow();
		});

		test('mix de NaN ET une valeur valide → some() détecte (court-circuit)', () => {
			// L36 some() retourne true dès le 1er élément non-fini.
			const vector = new Array(1536).fill(0.5);
			vector[1535] = NaN; // seulement le dernier
			expect(() => validateVectorGlobal(vector)).toThrow(
				'Vector contient NaN ou Infinity'
			);
		});
	});

	// ============================================================
	// validateVectorGlobal — L17 non-array typeof détails [COLD]
	// ============================================================
	describe('validateVectorGlobal — L17-24 non-array typeof details [COLD]', () => {
		test('number input → receivedType "number"', () => {
			try {
				validateVectorGlobal(42 as any);
				expect.fail('Should throw');
			} catch (err: any) {
				expect(err.code).toBe('INVALID_VECTOR_TYPE');
				expect(err.details).toEqual({
					receivedType: 'number',
					expectedType: 'array',
				});
			}
		});

		test('boolean input → receivedType "boolean"', () => {
			try {
				validateVectorGlobal(true as any);
				expect.fail('Should throw');
			} catch (err: any) {
				expect(err.details.receivedType).toBe('boolean');
			}
		});

		test('function input → receivedType "function"', () => {
			try {
				validateVectorGlobal((() => {}) as any);
				expect.fail('Should throw');
			} catch (err: any) {
				expect(err.details.receivedType).toBe('function');
			}
		});

		test('symbol input → receivedType "symbol"', () => {
			try {
				validateVectorGlobal(Symbol('x') as any);
				expect.fail('Should throw');
			} catch (err: any) {
				expect(err.details.receivedType).toBe('symbol');
			}
		});

		test('null input → message contient "object" (typeof null)', () => {
			// Pin : typeof null = 'object' (quirk JS). Message reflète ça.
			try {
				validateVectorGlobal(null as any);
				expect.fail('Should throw');
			} catch (err: any) {
				expect(err.message).toContain('object');
				expect(err.details.receivedType).toBe('object');
			}
		});
	});

	// ============================================================
	// validateVectorGlobal — error shape complet (service, cause, category)
	// ============================================================
	describe('validateVectorGlobal — StateManagerError shape pinné', () => {
		test('toutes les erreurs ont service === "EmbeddingValidator"', () => {
			// Pin le service tag pour le traçage.
			for (const input of ['x' as any, 42 as any, null as any]) {
				try {
					validateVectorGlobal(input);
					expect.fail('Should throw');
				} catch (err: any) {
					expect(err.service).toBe('EmbeddingValidator');
					expect(err).toBeInstanceOf(StateManagerError);
					expect(err.name).toBe('StateManagerError');
				}
			}
		});

		test('erreur type → pas de details cause/category', () => {
			// Pin que cause/category ne sont pas passés (undefined).
			try {
				validateVectorGlobal('x' as any);
				expect.fail('Should throw');
			} catch (err: any) {
				expect(err.cause).toBeUndefined();
			}
		});
	});

	// ============================================================
	// sanitizePayload — L57-66 ordering [COLD]
	// ============================================================
	describe('sanitizePayload — L57-66 ordering [COLD]', () => {
		test('parent_task_id=undefined → retiré par L57 (avant L60 null check)', () => {
			// L57 (`=== undefined`) s'exécute avant L60 (`=== null`).
			// undefined n'est pas null → L60 ne s'applique pas de toute façon,
			// mais pin que L57 retire les special keys undefined.
			const payload = { parent_task_id: undefined, key: 'val' };
			const result = sanitizePayload(payload);
			expect(result).not.toHaveProperty('parent_task_id');
			expect(result).toEqual({ key: 'val' });
		});

		test('root_task_id=undefined → retiré par L57', () => {
			const payload = { root_task_id: undefined, key: 'val' };
			const result = sanitizePayload(payload);
			expect(result).not.toHaveProperty('root_task_id');
		});

		test('parent_task_id="" (empty string) → retiré par L64 (empty check)', () => {
			// L64 ne exclude pas les special keys → empty string special key retiré.
			const payload = { parent_task_id: '', key: 'val' };
			const result = sanitizePayload(payload);
			expect(result).not.toHaveProperty('parent_task_id');
		});

		test('root_task_id="   " (whitespace) → retiré par L64 trim()', () => {
			const payload = { root_task_id: '   ', key: 'val' };
			const result = sanitizePayload(payload);
			expect(result).not.toHaveProperty('root_task_id');
		});

		test('special keys null simultanés → les deux conservés', () => {
			// Base teste chaque special key séparément. Pin les deux ensemble.
			const payload = {
				parent_task_id: null,
				root_task_id: null,
				other: null,
			};
			const result = sanitizePayload(payload);
			expect(result).toEqual({
				parent_task_id: null,
				root_task_id: null,
			});
		});

		test('ordre de clé : special key null avant/après normal null', () => {
			// Peu importe l'ordre, le forEach traite chaque clé.
			const payload = {
				normalNull: null,
				parent_task_id: null,
				anotherNormal: null,
				root_task_id: null,
			};
			const result = sanitizePayload(payload);
			expect(result).toEqual({
				parent_task_id: null,
				root_task_id: null,
			});
		});
	});

	// ============================================================
	// sanitizePayload — payload hostile (null/undefined/array/primitive)
	// ============================================================
	describe('sanitizePayload — payload hostile [COLD]', () => {
		test('null → {...null} = {} (no crash)', () => {
			// Spread sur null = {} (propriétés énumérables de null = aucune).
			const result = sanitizePayload(null);
			expect(result).toEqual({});
		});

		test('undefined → {...undefined} = {} (no crash)', () => {
			const result = sanitizePayload(undefined);
			expect(result).toEqual({});
		});

		test('array as payload → indices deviennent clés string', () => {
			// {...[10,20,30]} = {0:10, 1:20, 2:30}. Object.keys = ['0','1','2'].
			const result = sanitizePayload([10, 20, 30] as any);
			expect(result).toEqual({ 0: 10, 1: 20, 2: 30 });
		});

		test('string as payload → chars deviennent clés (avec undefined values)', () => {
			// {...'abc'} = {0:'a', 1:'b', 2:'c'}. Pin qu'une string n'est pas un
			// payload valide mais ne crash pas.
			const result = sanitizePayload('abc' as any);
			expect(result).toEqual({ 0: 'a', 1: 'b', 2: 'c' });
		});

		test('number as payload → {} (no enumerable props)', () => {
			// {...42} = {}. Number n'a pas de props énumérables propres.
			const result = sanitizePayload(42 as any);
			expect(result).toEqual({});
		});

		test('boolean as payload → {} (no enumerable props)', () => {
			const result = sanitizePayload(true as any);
			expect(result).toEqual({});
		});
	});

	// ============================================================
	// sanitizePayload — shallow copy (nested NOT cleaned) [pin]
	// ============================================================
	describe('sanitizePayload — shallow copy nested [pin]', () => {
		test('nested object undefined NOT cleaned (shallow)', () => {
			// Pin le comportement shallow : la copie est superficielle.
			const payload = { nested: { a: 'x', b: undefined } };
			const result = sanitizePayload(payload);
			expect(result.nested).toEqual({ a: 'x', b: undefined });
		});

		test('nested null NOT cleaned', () => {
			const payload = { nested: { a: null } };
			const result = sanitizePayload(payload);
			expect((result.nested as any).a).toBeNull();
		});

		test('nested empty string NOT cleaned', () => {
			const payload = { nested: { a: '' } };
			const result = sanitizePayload(payload);
			expect((result.nested as any).a).toBe('');
		});

		test('array values NOT inspected (seulement keys top-level)', () => {
			// Array avec undefined dedans : non nettoyé (shallow).
			const payload = { arr: [1, undefined, 3] };
			const result = sanitizePayload(payload);
			expect(result.arr).toEqual([1, undefined, 3]);
		});
	});

	// ============================================================
	// sanitizePayload — L64 trim() format [pin]
	// ============================================================
	describe('sanitizePayload — L64 trim empty/whitespace [pin]', () => {
		test('string "0" (zero string) → conservé (trim()="0" non vide)', () => {
			const payload = { k: '0' };
			const result = sanitizePayload(payload);
			expect(result).toEqual({ k: '0' });
		});

		test('string "\\t\\n" (tabs/newlines) → retiré (trim vide)', () => {
			const payload = { k: '\t\n' };
			const result = sanitizePayload(payload);
			expect(result).toEqual({});
		});

		test('string "  x  " (avec contenu) → conservé (trim non vide, mais valeur pas trimée)', () => {
			// Pin : trim() sert seulement au check, la valeur n'est PAS trimée.
			const payload = { k: '  x  ' };
			const result = sanitizePayload(payload);
			expect(result).toEqual({ k: '  x  ' });
		});

		test('nombre 0 → conservé (typeof !== string, skip L64)', () => {
			// L64 `typeof === 'string'`. 0 est number → skip.
			const payload = { k: 0 };
			const result = sanitizePayload(payload);
			expect(result).toEqual({ k: 0 });
		});
	});

	// ============================================================
	// sanitizePayload — keys with special chars / edge
	// ============================================================
	describe('sanitizePayload — keys edge [COLD]', () => {
		test('clé avec nom "undefined" (string literal) + value définie → conservé', () => {
			// La clé est la string 'undefined', pas la valeur undefined.
			const payload = { undefined: 'val' };
			const result = sanitizePayload(payload);
			expect(result).toEqual({ undefined: 'val' });
		});

		test('clé avec nom "null" (string literal) + value non-null → conservé', () => {
			const payload = { null: 'val' };
			const result = sanitizePayload(payload);
			expect(result).toEqual({ null: 'val' });
		});

		test('clé numérique (de array) avec value undefined → retiré', () => {
			// Array avec trou : {0:'a', 2:'c'} (index 1 absent).
			// {...['a',,'c']} → {0:'a', 2:'c'} (pas de clé 1).
			const result = sanitizePayload(['a', , 'c'] as any);
			expect(result).toEqual({ 0: 'a', 2: 'c' });
			expect(result).not.toHaveProperty('1');
		});

		test('symbol key → ignoré par Object.keys (non-énumérable comme string key)', () => {
			// Object.keys ne retourne pas les Symbol keys. Le symbole survit.
			const sym = Symbol('x');
			const payload = { [sym]: 'val', normal: 'n' };
			const result = sanitizePayload(payload);
			expect(result.normal).toBe('n');
			expect(result[sym]).toBe('val');
		});
	});
});
