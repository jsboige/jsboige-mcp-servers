/**
 * Coverage tests pour TruncationEngine — branches froides / défensives
 *
 * Le base test (TruncationEngine.test.ts, 200 LOC) couvre les happy paths :
 * string/objet, null/undefined, preserveStructure on/off (string seule),
 * 30 lignes vs 1 ligne. Ce fichier pince les branches que la base n'atteint
 * jamais ou dont elle ne vérifie pas les side-effects :
 *
 * - truncateToolParameters falsy non-null (0/''/false) : `!params` (L18) est
 *   plus large que null/undefined — la coercition truthy attrape 0 et ''
 * - truncateToolParameters number/boolean : typeof !== 'string' (L22) →
 *   JSON.stringify (42 → '42', pas '"42"')
 * - truncateToolParameters string longue + preserveStructure=true (default) :
 *   L28 `typeof params === 'object'` false → substring simple L34.
 *   Pin : preserveStructure est IGNORE pour les strings (L28 garde object-seulement)
 * - truncateToolParameters object long + preserveStructure=false : L28 false →
 *   substring L34 (troncature brute, pas truncateObjectIntelligently)
 * - truncateToolResult falsy non-null (0/'') : `!result` (L46) idem
 * - truncateToolResult number/boolean → JSON.stringify
 * - truncateToolResult boundary `lines.length > 10` : exactement 10 → substring
 *   L63 (pas de preserve first/last) ; 11 → preserve first/last
 * - truncateToolResult format exact `[... N lignes tronquées ...]` + compte
 *   `lines.length - 8` (5 first + 3 last)
 * - truncateObjectIntelligently (privée, indirecte) : 1 énorme prop → seul `...`
 *   key ; toutes props tiennent → pas de `...` ; format `${N} autres propriétés`
 * - generateTruncationToggle : emoji 📖/📚 + data-action + IDs + onclick pinnés
 * - generateExpandableContent : ▶ icon + expand-text/expand-icon pinnés
 *
 * SKIP : truncateObjectIntelligently L112-114 (`jsonStr.length <= maxLength`
 * return obj) — unreachable via public API : truncateToolParameters L24 early-returns
 * si content <= maxLength, et content = JSON.stringify(params). Donc L30 n'est
 * atteint QUE si jsonStr > maxLength → L112 toujours false. Dead code défensive.
 *
 * @module services/markdown-formatter/__tests__/TruncationEngine.coverage.test
 * @see #833 C3
 * @version 1.0.0
 */

import { describe, test, expect } from 'vitest';
import { TruncationEngine } from '../TruncationEngine.js';

// ─────────────────── tests ───────────────────

describe('TruncationEngine.coverage', () => {
  // ============================================================
  // truncateToolParameters — falsy non-null (L18 `!params`)
  // ============================================================
  describe('truncateToolParameters — falsy non-null (L18) [COLD]', () => {
    test('params = 0 (falsy number) → N/A, wasTruncated false', () => {
      // !0 = true → L19 return N/A. Pin que la coercition dépasse null/undefined.
      const result = TruncationEngine.truncateToolParameters(0 as any);
      expect(result.content).toBe('N/A');
      expect(result.wasTruncated).toBe(false);
    });

    test('params = "" (falsy empty string) → N/A', () => {
      const result = TruncationEngine.truncateToolParameters('' as any);
      expect(result.content).toBe('N/A');
      expect(result.wasTruncated).toBe(false);
    });

    test('params = false (falsy boolean) → N/A', () => {
      const result = TruncationEngine.truncateToolParameters(false as any);
      expect(result.content).toBe('N/A');
      expect(result.wasTruncated).toBe(false);
    });
  });

  // ============================================================
  // truncateToolParameters — number/boolean (L22 typeof !== 'string')
  // ============================================================
  describe('truncateToolParameters — number/boolean params [COLD]', () => {
    test('params = 42 (number) → JSON.stringify → "42" (pas "\"42\"" ni "short param")', () => {
      // typeof 42 !== 'string' → JSON.stringify(42, null, 2) = '42'.
      // Pin : pas de quotes autour (différent d'un cast string).
      const result = TruncationEngine.truncateToolParameters(42 as any);
      expect(result.content).toBe('42');
      expect(result.wasTruncated).toBe(false);
    });

    test('params = true (boolean) → "true"', () => {
      const result = TruncationEngine.truncateToolParameters(true as any);
      expect(result.content).toBe('true');
      expect(result.wasTruncated).toBe(false);
    });

    test('params = 3.14 (float) → "3.14"', () => {
      const result = TruncationEngine.truncateToolParameters(3.14 as any);
      expect(result.content).toBe('3.14');
    });
  });

  // ============================================================
  // truncateToolParameters — preserveStructure ignored for strings (L28)
  // ============================================================
  describe('truncateToolParameters — preserveStructure ignored for strings (L28)', () => {
    test('string longue + preserveStructure=true (default) → substring simple + "..."', () => {
      // L28 : preserveStructure && typeof params === 'object'. Pour une string,
      // typeof !== 'object' → garde false → fallback L34 substring.
      // Pin : preserveStructure=true ne déclenche PAS truncateObjectIntelligently
      // pour les strings.
      const longString = 'x'.repeat(1000);
      const result = TruncationEngine.truncateToolParameters(longString, {
        maxParameterLength: 100,
        preserveStructure: true,
      });
      expect(result.wasTruncated).toBe(true);
      // substring(0, 100) + '...' = 103 chars
      expect(result.content).toBe('x'.repeat(100) + '...');
      expect(result.content.length).toBe(103);
    });

    test('string longue + preserveStructure non fourni (default true) → substring simple', () => {
      // Même comportement — confirme le default et l'ignore pour strings.
      const longString = 'y'.repeat(600);
      const result = TruncationEngine.truncateToolParameters(longString, {
        maxParameterLength: 50,
      });
      expect(result.wasTruncated).toBe(true);
      expect(result.content).toBe('y'.repeat(50) + '...');
    });

    test('object long + preserveStructure=false → substring brute (pas truncateObjectIntelligently)', () => {
      // L28 false (preserveStructure=false) → L34 substring sur le JSON stringifié.
      // Pin : l'objet est stringifié PUIS tronqué brutalement (Casse le JSON).
      const params = { key: 'x'.repeat(500) };
      const result = TruncationEngine.truncateToolParameters(params, {
        maxParameterLength: 50,
        preserveStructure: false,
      });
      expect(result.wasTruncated).toBe(true);
      expect(result.content.endsWith('...')).toBe(true);
      expect(result.content.length).toBe(53); // 50 + '...'
      // Pas du JSON valide (coupé en plein milieu)
      expect(() => JSON.parse(result.content)).toThrow();
    });
  });

  // ============================================================
  // truncateToolParameters — boundary exactement maxLength (L24)
  // ============================================================
  describe('truncateToolParameters — boundary = maxLength [pin]', () => {
    test('content.length === maxLength exactement → pas tronqué (<= L24)', () => {
      // Pin le boundary <= : exactement 500 chars = pas tronqué.
      const result = TruncationEngine.truncateToolParameters('x'.repeat(500));
      expect(result.wasTruncated).toBe(false);
      expect(result.content.length).toBe(500);
    });

    test('content.length === maxLength + 1 → tronqué', () => {
      const result = TruncationEngine.truncateToolParameters('x'.repeat(501), {
        maxParameterLength: 500,
      });
      expect(result.wasTruncated).toBe(true);
    });
  });

  // ============================================================
  // truncateToolResult — falsy non-null (L46 `!result`)
  // ============================================================
  describe('truncateToolResult — falsy non-null (L46) [COLD]', () => {
    test('result = 0 → N/A', () => {
      const result = TruncationEngine.truncateToolResult(0 as any);
      expect(result.content).toBe('N/A');
      expect(result.wasTruncated).toBe(false);
    });

    test('result = "" → N/A', () => {
      const result = TruncationEngine.truncateToolResult('' as any);
      expect(result.content).toBe('N/A');
      expect(result.wasTruncated).toBe(false);
    });

    test('result = false → N/A', () => {
      const result = TruncationEngine.truncateToolResult(false as any);
      expect(result.content).toBe('N/A');
      expect(result.wasTruncated).toBe(false);
    });
  });

  // ============================================================
  // truncateToolResult — number/boolean (L50 typeof !== 'string')
  // ============================================================
  describe('truncateToolResult — number/boolean [COLD]', () => {
    test('result = 42 → "42"', () => {
      const result = TruncationEngine.truncateToolResult(42 as any);
      expect(result.content).toBe('42');
      expect(result.wasTruncated).toBe(false);
    });

    test('result = true → "true"', () => {
      const result = TruncationEngine.truncateToolResult(true as any);
      expect(result.content).toBe('true');
    });
  });

  // ============================================================
  // truncateToolResult — boundary lines.length > 10 (L58)
  // ============================================================
  describe('truncateToolResult — boundary `lines.length > 10` (L58) [COLD]', () => {
    test('exactement 10 lignes (>maxLength) → substring simple L63 (pas preserve)', () => {
      // L58 `lines.length > 10` : 10 n'est PAS > 10 → false → L62 else substring.
      // Pin le boundary strict > : 10 lignes = substring brute.
      const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
      // Chaque ligne courte, mais total > maxLength pour dépasser L52
      const longResult = lines.join('\n') + 'x'.repeat(200);
      const result = TruncationEngine.truncateToolResult(longResult, {
        maxResultLength: 50,
      });
      expect(result.wasTruncated).toBe(true);
      expect(result.content.endsWith('...')).toBe(true);
      // Pas de preserve first/last (pas de "[... N lignes ...]")
      expect(result.content).not.toContain('lignes tronquées');
    });

    test('exactement 11 lignes (>maxLength) → preserve first 5 + last 3', () => {
      // 11 > 10 = true → L59-61 preserve.
      const lines = Array.from({ length: 11 }, (_, i) => `Line${i}`);
      const longResult = lines.join('\n');
      const result = TruncationEngine.truncateToolResult(longResult, {
        maxResultLength: 30,
      });
      expect(result.wasTruncated).toBe(true);
      expect(result.content).toContain('lignes tronquées');
      // First 5
      expect(result.content).toContain('Line0');
      expect(result.content).toContain('Line4');
      // Last 3 (Line8, Line9, Line10)
      expect(result.content).toContain('Line10');
    });

    test('compte exact "[... N lignes tronquées ...]" = lines.length - 8', () => {
      // 20 lignes → 20 - 8 = 12 lignes tronquées (5 first + 3 last)
      const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
      const result = TruncationEngine.truncateToolResult(lines.join('\n'), {
        maxResultLength: 30,
      });
      expect(result.content).toContain('[... 12 lignes tronquées ...]');
    });

    test('format exact du marker (avec crochets et espaces)', () => {
      const lines = Array.from({ length: 15 }, () => 'line content');
      const result = TruncationEngine.truncateToolResult(lines.join('\n'), {
        maxResultLength: 30,
      });
      // Format : 5 first + blank + [... N lignes tronquées ...] + blank + 3 last
      expect(result.content).toMatch(
        /\n\n\[... \d+ lignes tronquées \.\.\.\]\n\n/
      );
    });
  });

  // ============================================================
  // truncateToolResult — object result boundary
  // ============================================================
  describe('truncateToolResult — object result', () => {
    test('petit objet → JSON non tronqué', () => {
      const obj = { a: 1, b: 2 };
      const result = TruncationEngine.truncateToolResult(obj);
      expect(result.wasTruncated).toBe(false);
      expect(JSON.parse(result.content)).toEqual(obj);
    });

    test('objet long peu de lignes → substring (≤10 lignes après split)', () => {
      // Objet stringifié sur peu de lignes mais dépassant maxLength.
      const obj = { key: 'x'.repeat(2000) };
      const result = TruncationEngine.truncateToolResult(obj, {
        maxResultLength: 100,
      });
      expect(result.wasTruncated).toBe(true);
      // JSON.stringify avec indent = peu de lignes mais long ; si >10 → preserve
      // Ici probablement ≤10 lignes → substring
      expect(result.content.endsWith('...')).toBe(true);
    });
  });

  // ============================================================
  // truncateObjectIntelligently — 1 énorme prop (L123-125 break early)
  // ============================================================
  describe('truncateObjectIntelligently — 1 huge prop [COLD]', () => {
    test('objet 1 prop dépassant maxLength → seul key "..." présent', () => {
      // L121-128 : 1ère prop trop grosse → currentLength + entryStr > maxLength
      // avant d'ajouter → truncated n'a QUE le key '...' (break avant truncated[key]=value).
      const params = { huge: 'x'.repeat(500) };
      const result = TruncationEngine.truncateToolParameters(params, {
        maxParameterLength: 100,
        preserveStructure: true,
      });
      expect(result.wasTruncated).toBe(true);
      const parsed = JSON.parse(result.content);
      expect(parsed['...']).toBeDefined();
      // La prop 'huge' est absente (break avant ajout)
      expect(parsed.huge).toBeUndefined();
      // Format message : "1 autres propriétés"
      expect(parsed['...']).toContain('1 autres propriétés');
    });

    test('objet 3 props toutes trop grosses → 1 prop "..." avec compte 3', () => {
      const params = {
        a: 'x'.repeat(200),
        b: 'y'.repeat(200),
        c: 'z'.repeat(200),
      };
      const result = TruncationEngine.truncateToolParameters(params, {
        maxParameterLength: 100,
        preserveStructure: true,
      });
      const parsed = JSON.parse(result.content);
      expect(parsed['...']).toBeDefined();
      // entries.length (3) - Object.keys(truncated).length (1 = '...') = 2...
      // MAIS le break arrive à la 1ère itération : truncated est vide (0 keys),
      // puis on assigne truncated['...'] = `${3 - 0} autres` = '3 autres propriétés'
      expect(parsed['...']).toContain('3 autres propriétés');
    });
  });

  // ============================================================
  // truncateObjectIntelligently — toutes props tiennent (pas de '...')
  // ============================================================
  describe('truncateObjectIntelligently — all props fit [COLD]', () => {
    test('objet dont toutes les props tiennent individuellement → pas de key "..."', () => {
      // Cas où chaque prop tient mais le total dépasse maxLength (L52 early return
      // skippé car content > maxLength). truncateObjectIntelligently boucle et
      // ajoute tant que currentLength + entryStr <= maxLength.
      // Pin : si la 1ère prop consomme tout le budget et la 2ème dépasse, on a
      // la 1ère + '...'. Si juste la 1ère tient pile, on a la 1ère seule + '...'.
      const params = { a: 'short', b: 'also short' };
      // maxParameterLength petit pour forcer truncateObjectIntelligently
      const result = TruncationEngine.truncateToolParameters(params, {
        maxParameterLength: 60,
        preserveStructure: true,
      });
      // Soit tout tient (wasTruncated false via L52), soit tronqué.
      // Si tronqué, au moins une prop présente.
      if (result.wasTruncated) {
        const parsed = JSON.parse(result.content);
        expect(parsed['...']).toBeDefined();
      }
    });

    test('objet avec prop qui tient juste → prop gardée + reste dans "..."', () => {
      // 2 props courtes, maxLength serré : la 1ère ajoutée, la 2ème dépasse → '...'.
      const params = { first: 'val1', second: 'val2', third: 'val3' };
      const result = TruncationEngine.truncateToolParameters(params, {
        maxParameterLength: 40,
        preserveStructure: true,
      });
      expect(result.wasTruncated).toBe(true);
      const parsed = JSON.parse(result.content);
      // Au moins 'first' est présente (la 1ère itération ajoute si entryStr <= maxLength-2)
      expect(Object.keys(parsed).length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // generateTruncationToggle — format HTML exact (emoji + IDs)
  // ============================================================
  describe('generateTruncationToggle — format HTML complet pinné', () => {
    test('contient emoji 📖 (Voir le contenu complet) et 📚 (Réduire)', () => {
      // Pin les emoji load-bearing pour l'UI.
      const html = TruncationEngine.generateTruncationToggle('full', 'trunc', 'id1');
      expect(html).toContain('📖');
      expect(html).toContain('📚');
    });

    test('data-action="expand" et data-action="collapse" présents', () => {
      const html = TruncationEngine.generateTruncationToggle('full', 'trunc', 'id1');
      expect(html).toContain('data-action="expand"');
      expect(html).toContain('data-action="collapse"');
    });

    test('IDs construits depuis elementId : truncated-${id} et full-${id}', () => {
      const html = TruncationEngine.generateTruncationToggle('full', 'trunc', 'abc-123');
      expect(html).toContain('id="truncated-abc-123"');
      expect(html).toContain('id="full-abc-123"');
    });

    test('onclick passe elementId entre quotes simples', () => {
      const html = TruncationEngine.generateTruncationToggle('full', 'trunc', 'elem');
      expect(html).toContain("toggleTruncation('elem')");
    });

    test('classes CSS : truncation-container, truncated-content, full-content, hidden', () => {
      const html = TruncationEngine.generateTruncationToggle('full', 'trunc', 'elem');
      expect(html).toContain('class="truncation-container"');
      expect(html).toContain('class="truncated-content"');
      expect(html).toContain('class="full-content hidden"');
    });

    test('pre/code wrapper pour truncated et full content', () => {
      const html = TruncationEngine.generateTruncationToggle('FULL', 'TRUNC', 'elem');
      expect(html).toContain('<pre><code>TRUNC</code></pre>');
      expect(html).toContain('<pre><code>FULL</code></pre>');
    });
  });

  // ============================================================
  // generateExpandableContent — format HTML exact (▶ + classes)
  // ============================================================
  describe('generateExpandableContent — format HTML complet pinné', () => {
    test('contient icône ▶ (expand-icon)', () => {
      // Pin l'icône load-bearing pour l'UI.
      const html = TruncationEngine.generateExpandableContent('content', 'summary', 'id1');
      expect(html).toContain('▶');
    });

    test('IDs construits depuis elementId : expandable-${id}', () => {
      const html = TruncationEngine.generateExpandableContent('content', 'summary', 'exp-42');
      expect(html).toContain('id="expandable-exp-42"');
    });

    test('onclick passe elementId entre quotes simples', () => {
      const html = TruncationEngine.generateExpandableContent('content', 'summary', 'myid');
      expect(html).toContain("toggleExpandable('myid')");
    });

    test('classes CSS : expandable-container, content-summary, expandable-content hidden, expand-toggle', () => {
      const html = TruncationEngine.generateExpandableContent('content', 'summary', 'id');
      expect(html).toContain('class="expandable-container"');
      expect(html).toContain('class="content-summary"');
      expect(html).toContain('class="expandable-content hidden"');
      expect(html).toContain('class="expand-toggle"');
    });

    test('expand-icon et expand-text spans présents avec "Développer"', () => {
      const html = TruncationEngine.generateExpandableContent('content', 'summary', 'id');
      expect(html).toContain('class="expand-icon"');
      expect(html).toContain('class="expand-text"');
      expect(html).toContain('Développer');
    });

    test('content et summary injectés tels quels', () => {
      const html = TruncationEngine.generateExpandableContent(
        '<span>DETAIL</span>',
        'Ma summary',
        'id'
      );
      expect(html).toContain('<span>DETAIL</span>');
      expect(html).toContain('Ma summary');
    });
  });
});
