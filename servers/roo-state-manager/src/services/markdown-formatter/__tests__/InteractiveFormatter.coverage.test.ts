/**
 * Coverage complement for InteractiveFormatter.ts — Issue #833 Sprint C3
 *
 * Add-only. Targets the two private type-mapping switches whose per-case arms
 * the existing suite (InteractiveFormatter.test.ts) never reaches, because it
 * only drives the public API with *capitalised* ClassifiedContent types, which
 * fall straight through to `default`:
 *   - getTypeIcon  (source L313-323): cases L315-320, default L321
 *   - getTypeLabel (source L328-338): cases L330-335, default L336
 *
 * FINDING (documented; source fix intentionally out of scope for a tests-only
 * C3 pass): the two live callers, generateTableOfContents at L39
 * (`this.getTypeIcon(type)` where `type` is a MessageCounters key: 'User',
 * 'Assistant', …) and L69 (`this.getTypeIcon(message.type)` where `message.type`
 * is a capitalised ClassifiedContent type), pass CAPITALISED strings, but both
 * switches match LOWERCASE literals only. So in production every interactive-ToC
 * entry resolves to `default` — '⚪' / 'Inconnu' — regardless of its real type.
 * These tests (a) lock the intended lowercase→icon/label mapping contract and
 * (b) pin the current capitalised→default fall-through so the latent case
 * mismatch is regression-visible until a source fix (lowercasing the lookup key)
 * is greenlit.
 *
 * @module services/markdown-formatter/__tests__/InteractiveFormatter.coverage
 */

import { describe, test, expect } from 'vitest';
import { InteractiveFormatter } from '../InteractiveFormatter.js';

// getTypeIcon / getTypeLabel are `private static`. TypeScript's `private` is a
// compile-time visibility rule only — at runtime the methods are ordinary static
// members — so an `any` cast is the standard way to exercise each switch arm
// directly. (The public API can only reach `default`; see file header.)
const IF = InteractiveFormatter as unknown as {
	getTypeIcon(type: string): string;
	getTypeLabel(type: string): string;
};

describe('InteractiveFormatter — private type-mapping switches (coverage #833)', () => {
	describe('getTypeIcon — one assertion per lowercase case (source L315-321)', () => {
		test.each([
			['user', '🔵'],          // L315
			['assistant', '🟢'],     // L316
			['tool_call', '🟠'],     // L317
			['tool_result', '🟣'],   // L318
			['metadata', '⚫'],      // L319
			['error', '🔴'],         // L320
		])('maps lowercase %s → %s', (type, icon) => {
			expect(IF.getTypeIcon(type)).toBe(icon);
		});

		test('unknown type → default ⚪ (L321)', () => {
			expect(IF.getTypeIcon('does-not-exist')).toBe('⚪');
		});
	});

	describe('getTypeLabel — one assertion per lowercase case (source L330-336)', () => {
		test.each([
			['user', 'Utilisateur'],          // L330
			['assistant', 'Assistant'],        // L331
			['tool_call', 'Appel Outil'],      // L332
			['tool_result', 'Résultat Outil'], // L333
			['metadata', 'Métadonnées'],       // L334
			['error', 'Erreur'],               // L335
		])('maps lowercase %s → %s', (type, label) => {
			expect(IF.getTypeLabel(type)).toBe(label);
		});

		test('unknown type → default Inconnu (L336)', () => {
			expect(IF.getTypeLabel('does-not-exist')).toBe('Inconnu');
		});
	});

	describe('FINDING — capitalised ClassifiedContent types fall through to default', () => {
		// Pins the current (buggy) production behaviour: the live callers pass
		// capitalised types, so neither switch matches → default icon/label.
		// If a source fix later lowercases the lookup key, these assertions are
		// the ones that must be revisited — making the mismatch impossible to
		// fix silently.
		test('capitalised "User"/"Assistant" resolve to default, not their lowercase mapping', () => {
			expect(IF.getTypeIcon('User')).toBe('⚪');
			expect(IF.getTypeIcon('Assistant')).toBe('⚪');
			expect(IF.getTypeLabel('User')).toBe('Inconnu');
			expect(IF.getTypeLabel('Assistant')).toBe('Inconnu');
		});
	});
});
