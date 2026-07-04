/**
 * Coverage tests pour MarkdownRenderer — branches froides / format pins
 *
 * Le base test (MarkdownRenderer.test.ts, 317 LOC) couvre les happy paths et
 * la présence de contenu. Ce fichier pince les branches et formats exacts que
 * la base ne vérifie pas :
 *
 * - timestamp ternary (L13/L31/L49/L68) : format exact `<small class="timestamp">`
 *   + cas truthy-non-string (timestamp=42 → interpolé tel quel)
 * - formatToolResult L77 `typeof === 'string'` : number/boolean/array → JSON.stringify
 *   (base ne teste que string/null/object)
 * - formatConversationHeader L98 `messageCount || 0` : messageCount=0 (falsy) → '0'
 * - L102 `totalSize || '0 KB'` : totalSize='' (empty falsy) → '0 KB'
 * - L106 `createdAt ? ... : 'N/A'` : format exact toLocaleDateString('fr-FR')
 * - L94 `title || default` : title='' (empty falsy) → défaut
 * - formatToolParametersTable L155 `!params || typeof !== 'object'` :
 *   array (typeof object) → génère rows avec clés numériques (différent de null/string)
 * - L156 `String(params)` format exact pour non-objects
 * - formatMetadataTable L133-135 : value non-string (number/boolean) interpolée brute
 *   (PAS JSON.stringify — pin la divergence avec formatToolParametersTable L160)
 *
 * @module services/markdown-formatter/__tests__/MarkdownRenderer.coverage.test
 * @see #833 C3
 * @version 1.0.0
 */

import { describe, test, expect } from 'vitest';
import { MarkdownRenderer } from '../MarkdownRenderer.js';

// ─────────────────── tests ───────────────────

describe('MarkdownRenderer.coverage', () => {
  // ============================================================
  // timestamp ternary — format exact (L13/L31/L49/L68)
  // ============================================================
  describe('timestamp ternary — format <small class="timestamp"> pinné', () => {
    test('formatUserMessage timestamp présent → format exact <small class="timestamp">', () => {
      const html = MarkdownRenderer.formatUserMessage('msg', '2026-07-04T12:00:00Z');
      expect(html).toContain('<small class="timestamp">2026-07-04T12:00:00Z</small>');
    });

    test('formatAssistantMessage timestamp → même format', () => {
      const html = MarkdownRenderer.formatAssistantMessage('msg', '2026-07-04T12:00:00Z');
      expect(html).toContain('<small class="timestamp">2026-07-04T12:00:00Z</small>');
    });

    test('formatToolCall timestamp → même format', () => {
      const html = MarkdownRenderer.formatToolCall('tool', {}, '2026-07-04T12:00:00Z');
      expect(html).toContain('<small class="timestamp">2026-07-04T12:00:00Z</small>');
    });

    test('formatToolResult timestamp → même format', () => {
      const html = MarkdownRenderer.formatToolResult('tool', 'res', '2026-07-04T12:00:00Z');
      expect(html).toContain('<small class="timestamp">2026-07-04T12:00:00Z</small>');
    });
  });

  // ============================================================
  // timestamp truthy-non-string (ternary `?`)
  // ============================================================
  describe('timestamp truthy-non-string [COLD]', () => {
    test('formatUserMessage timestamp=42 (truthy number) → interpolé tel quel', () => {
      // ternary `timestamp ?` ne vérifie pas le type — 42 est truthy → inclus.
      // Pin : pas de validation de type sur timestamp.
      const html = MarkdownRenderer.formatUserMessage('msg', 42 as any);
      expect(html).toContain('<small class="timestamp">42</small>');
    });

    test('formatUserMessage timestamp=true (truthy boolean) → "true"', () => {
      const html = MarkdownRenderer.formatUserMessage('msg', true as any);
      expect(html).toContain('<small class="timestamp">true</small>');
    });

    test('formatUserMessage timestamp=0 (falsy) → pas de <small>', () => {
      // Pin : falsy = pas de timestamp (cohérent avec undefined).
      const html = MarkdownRenderer.formatUserMessage('msg', 0 as any);
      expect(html).not.toContain('<small');
    });

    test('formatUserMessage timestamp="" (empty falsy) → pas de <small>', () => {
      const html = MarkdownRenderer.formatUserMessage('msg', '' as any);
      expect(html).not.toContain('<small');
    });
  });

  // ============================================================
  // formatToolResult L77 — typeof branches (number/boolean/array)
  // ============================================================
  describe('formatToolResult L77 typeof branches [COLD]', () => {
    test('result = 42 (number) → JSON.stringify → "42"', () => {
      // typeof 42 !== 'string' → JSON.stringify(42, null, 2) = '42'.
      // Pin : pas de quotes (différent d'une string "42").
      const html = MarkdownRenderer.formatToolResult('tool', 42);
      expect(html).toContain('42');
      // Pas d'escape JSON de string (pas de quotes autour)
      expect(html).not.toContain('"42"');
    });

    test('result = true (boolean) → "true"', () => {
      const html = MarkdownRenderer.formatToolResult('tool', true);
      expect(html).toContain('true');
      expect(html).not.toContain('"true"');
    });

    test('result = [1,2,3] (array) → JSON array multi-ligne sérialisé', () => {
      const html = MarkdownRenderer.formatToolResult('tool', [1, 2, 3]);
      // JSON.stringify([1,2,3], null, 2) = multi-ligne. Numbers sans quotes.
      expect(html).not.toContain('"1"');
      expect(html).toContain('1,');
      expect(html).toContain('2,');
      expect(html).toContain('3');
    });

    test('result = undefined → JSON.stringify → "undefined" string', () => {
      // typeof undefined !== 'string' → JSON.stringify(undefined) = undefined
      // (pas une string !) → interpolation template → "undefined" literal.
      const html = MarkdownRenderer.formatToolResult('tool', undefined);
      // Le template `${JSON.stringify(undefined)}` = "undefined" (la valeur JS
      // undefined stringifie en undefined, interpolé comme "undefined")
      expect(html).toContain('undefined');
    });

    test('result = NaN (number) → JSON.stringify → "null"', () => {
      // JSON.stringify(NaN) = 'null' (NaN n'est pas valide JSON).
      const html = MarkdownRenderer.formatToolResult('tool', NaN);
      expect(html).toContain('null');
    });
  });

  // ============================================================
  // formatConversationHeader — falsy defaults (L94/L98/L102)
  // ============================================================
  describe('formatConversationHeader — falsy defaults (L94/L98/L102) [COLD]', () => {
    test('title="" (empty falsy) → titre par défaut', () => {
      // L94 `metadata.title || default`. '' est falsy → défaut.
      const html = MarkdownRenderer.formatConversationHeader({
        taskId: 'x',
        title: '',
      });
      expect(html).toContain("RESUME DE TRACE D'ORCHESTRATION ROO");
    });

    test('title=0 (falsy number) → titre par défaut', () => {
      const html = MarkdownRenderer.formatConversationHeader({
        taskId: 'x',
        title: 0 as any,
      });
      expect(html).toContain("RESUME DE TRACE D'ORCHESTRATION ROO");
    });

    test('messageCount=0 (falsy) → "0" via || 0 (L98)', () => {
      // L98 `${metadata.messageCount || 0}`. 0 || 0 = 0 → "0".
      // Pin : 0 et absent donnent le même rendu "0".
      const html = MarkdownRenderer.formatConversationHeader({
        taskId: 'x',
        messageCount: 0,
      });
      expect(html).toContain('>0<'); // stat-value contient "0"
    });

    test('totalSize="" (empty falsy) → "0 KB" (L102)', () => {
      // L102 `metadata.totalSize || '0 KB'`. '' falsy → '0 KB'.
      const html = MarkdownRenderer.formatConversationHeader({
        taskId: 'x',
        totalSize: '',
      });
      expect(html).toContain('0 KB');
    });

    test('totalSize=0 (falsy number) → "0 KB"', () => {
      const html = MarkdownRenderer.formatConversationHeader({
        taskId: 'x',
        totalSize: 0 as any,
      });
      expect(html).toContain('0 KB');
    });
  });

  // ============================================================
  // formatConversationHeader L106 — toLocaleDateString('fr-FR') format
  // ============================================================
  describe('formatConversationHeader — toLocaleDateString fr-FR (L106)', () => {
    test('createdAt valide → date au format fr-FR (dd/mm/yyyy)', () => {
      // Pin la régionalisation fr-FR : pas de format ISO, pas en-US.
      const html = MarkdownRenderer.formatConversationHeader({
        taskId: 'x',
        createdAt: '2026-07-04T10:00:00Z',
      });
      // toLocaleDateString('fr-FR') → "04/07/2026"
      expect(html).toContain('04/07/2026');
      // Pas de format ISO fallback
      expect(html).not.toContain('2026-07-04T');
    });

    test('createdAt date ancienne → format fr-FR cohérent', () => {
      const html = MarkdownRenderer.formatConversationHeader({
        taskId: 'x',
        createdAt: '2020-01-15T00:00:00Z',
      });
      expect(html).toContain('15/01/2020');
    });

    test('createdAt invalide → "Invalid Date" interpolé (toLocaleDateString)', () => {
      // new Date('garbage').toLocaleDateString('fr-FR') = 'Invalid Date'.
      // Pin : pas de guard sur date invalide → fuite "Invalid Date" dans le rendu.
      const html = MarkdownRenderer.formatConversationHeader({
        taskId: 'x',
        createdAt: 'not-a-date',
      });
      expect(html).toContain('Invalid Date');
    });
  });

  // ============================================================
  // formatToolParametersTable L155 — array (typeof === 'object')
  // ============================================================
  describe('formatToolParametersTable — array params [COLD]', () => {
    test('params = [1,2] (array, typeof object) → génère rows avec clés 0/1', () => {
      // L155 `!params || typeof !== 'object'`. Array n'est pas null et
      // typeof === 'object' → passe le guard → Object.entries(['a','b']) =
      // [['0','a'],['1','b']]. Pin : arrays traités comme objets (clés = indices).
      const html = MarkdownRenderer.formatToolParametersTable(['a', 'b']);
      expect(html).toContain('<table');
      expect(html).toContain('<code>0</code>');
      expect(html).toContain('<code>1</code>');
      expect(html).toContain('a');
      expect(html).toContain('b');
    });

    test('params = [] (empty array) → tableau vide mais <table> (pas <pre>)', () => {
      // Array vide passe le guard (typeof object, ![] = false) → tableau HTML
      // avec 0 rows. Pin : différent de null/string qui retournent <pre>.
      const html = MarkdownRenderer.formatToolParametersTable([]);
      expect(html).toContain('<table');
      expect(html).not.toContain('<pre><code>');
    });

    test('params = Date (instance, typeof object) → traité comme objet', () => {
      const d = new Date('2026-01-01');
      const html = MarkdownRenderer.formatToolParametersTable(d);
      // Date est un object → Object.entries(Date) = [] (props sur prototype
      // non énumérables) → tableau HTML vide.
      expect(html).toContain('<table');
    });
  });

  // ============================================================
  // formatToolParametersTable L156 — String(params) format exact
  // ============================================================
  describe('formatToolParametersTable L156 — String(params) non-objects', () => {
    test('params = 42 → <pre><code>42</code></pre>', () => {
      // String(42) = '42'.
      const html = MarkdownRenderer.formatToolParametersTable(42);
      expect(html).toContain('<pre><code>42</code></pre>');
    });

    test('params = true → <pre><code>true</code></pre>', () => {
      const html = MarkdownRenderer.formatToolParametersTable(true);
      expect(html).toContain('<pre><code>true</code></pre>');
    });

    test('params = null → <pre><code>null</code></pre>', () => {
      // String(null) = 'null'. Pin format exact (base teste 'null' substring).
      const html = MarkdownRenderer.formatToolParametersTable(null);
      expect(html).toContain('<pre><code>null</code></pre>');
    });

    test('params = undefined → <pre><code>undefined</code></pre>', () => {
      // String(undefined) = 'undefined'.
      const html = MarkdownRenderer.formatToolParametersTable(undefined);
      expect(html).toContain('<pre><code>undefined</code></pre>');
    });

    test('params = function → <pre><code>function...</code></pre>', () => {
      // typeof function === 'function' (pas 'object') → guard vrai → String(fn).
      const fn = function myFn() {};
      const html = MarkdownRenderer.formatToolParametersTable(fn);
      expect(html).toContain('<pre><code>');
      expect(html).toContain('function');
    });
  });

  // ============================================================
  // formatToolParametersTable L160 — value non-string in rows
  // ============================================================
  describe('formatToolParametersTable L160 — value typeof branches', () => {
    test('value = number → JSON.stringify (pas interpolation brute)', () => {
      // L160 `typeof value === 'string' ? value : JSON.stringify(value)`.
      // number n'est pas string → JSON.stringify(42) = '42'.
      const html = MarkdownRenderer.formatToolParametersTable({ count: 42 });
      expect(html).toContain('42');
    });

    test('value = object nested → JSON multi-ligne', () => {
      const html = MarkdownRenderer.formatToolParametersTable({
        opts: { nested: true },
      });
      expect(html).toContain('"nested"');
      expect(html).toContain('true');
    });

    test('value = array → JSON array multi-ligne sérialisé', () => {
      const html = MarkdownRenderer.formatToolParametersTable({ list: [1, 2] });
      // JSON.stringify([1,2], null, 2) = multi-ligne. Numbers sans quotes.
      expect(html).not.toContain('"1"');
      expect(html).toContain('1');
      expect(html).toContain('2');
    });

    test('value = null → JSON.stringify → "null"', () => {
      const html = MarkdownRenderer.formatToolParametersTable({ x: null });
      expect(html).toContain('null');
    });

    test('value = boolean → JSON.stringify → "true"/"false"', () => {
      const html = MarkdownRenderer.formatToolParametersTable({ a: true, b: false });
      expect(html).toContain('true');
      expect(html).toContain('false');
    });
  });

  // ============================================================
  // formatMetadataTable L133-135 — value non-string (DIVERGENCE pin)
  // ============================================================
  describe('formatMetadataTable — value non-string interpolée brute (L134) [DIVERGENCE]', () => {
    test('value = number → interpolé brute (PAS JSON.stringify)', () => {
      // DIVERGENCE avec formatToolParametersTable L160 : ici pas de typeof
      // guard → `${value}` interpolation brute. 42 → '42' (même rendu ici,
      // mais pin le codepath : pas de JSON.stringify sur metadata values).
      const html = MarkdownRenderer.formatMetadataTable({ count: 42 });
      expect(html).toContain('>42<');
      // Pas d'escape JSON
      expect(html).not.toContain('[42]');
    });

    test('value = boolean → interpolé brute', () => {
      const html = MarkdownRenderer.formatMetadataTable({ active: true });
      expect(html).toContain('>true<');
    });

    test('value = object → interpolé brute "[object Object]"', () => {
      // Pin la divergence : object interpolé via template = '[object Object]'
      // (alors que formatToolParametersTable ferait JSON.stringify).
      const html = MarkdownRenderer.formatMetadataTable({ opts: { a: 1 } });
      expect(html).toContain('[object Object]');
    });

    test('value = null → interpolé vide (template null → "null")', () => {
      const html = MarkdownRenderer.formatMetadataTable({ x: null });
      expect(html).toContain('>null<');
    });

    test('value = array → interpolé brute (join virgule)', () => {
      // `${[1,2,3]}` = '1,2,3' (Array.toString).
      const html = MarkdownRenderer.formatMetadataTable({ list: [1, 2, 3] });
      expect(html).toContain('>1,2,3<');
    });
  });

  // ============================================================
  // formatMetadataTable — row format exact (L134)
  // ============================================================
  describe('formatMetadataTable — row format <tr><td><strong>key</strong></td><td>value</td></tr>', () => {
    test('clé enveloppée dans <strong> dans le premier <td>', () => {
      const html = MarkdownRenderer.formatMetadataTable({ machineId: 'test' });
      expect(html).toContain(
        '<tr><td><strong>machineId</strong></td><td>test</td></tr>'
      );
    });

    test('clé spéciale avec caractères HTML non échappés', () => {
      // Pin : pas d'échappement HTML sur les keys/values (XSS potentiel,
      // mais behavior actuel). '<' reste '<'.
      const html = MarkdownRenderer.formatMetadataTable({ '<b>': 'x' });
      expect(html).toContain('<strong><b></strong>');
    });

    test('valeur avec caractères spéciaux non échappée', () => {
      const html = MarkdownRenderer.formatMetadataTable({ k: 'a<b>c' });
      expect(html).toContain('>a<b>c<');
    });
  });

  // ============================================================
  // formatConversationHeader — structure complète pinnée
  // ============================================================
  describe('formatConversationHeader — structure HTML complète', () => {
    test('contient stats-grid avec 3 stat-cards', () => {
      const html = MarkdownRenderer.formatConversationHeader({
        taskId: 't1',
        messageCount: 5,
        totalSize: '10 KB',
        createdAt: '2026-01-01T00:00:00Z',
      });
      // 3 stat-cards : Messages, Taille, Créé le
      const cardCount = (html.match(/class="stat-card"/g) || []).length;
      expect(cardCount).toBe(3);
      expect(html).toContain('Messages');
      expect(html).toContain('Taille');
      expect(html).toContain('Créé le');
    });

    test('contient metadata-section avec ID de Tâche', () => {
      const html = MarkdownRenderer.formatConversationHeader({ taskId: 'task-xyz' });
      expect(html).toContain('ID de Tâche');
      expect(html).toContain('<code>task-xyz</code>');
    });

    test('contient section-separator final', () => {
      const html = MarkdownRenderer.formatConversationHeader({ taskId: 'x' });
      expect(html).toContain('class="section-separator"');
    });

    test('h1 contient le titre', () => {
      const html = MarkdownRenderer.formatConversationHeader({
        taskId: 'x',
        title: 'Mon Titre',
      });
      expect(html).toContain('<h1>Mon Titre</h1>');
    });
  });

  // ============================================================
  // formatSectionSeparator — format exact inline style (L124-126)
  // ============================================================
  describe('formatSectionSeparator — inline style format pinné', () => {
    test('border-color et color appliqués via inline style', () => {
      const html = MarkdownRenderer.formatSectionSeparator('Title', '#ff0000');
      expect(html).toContain('style="border-color: #ff0000"');
      expect(html).toContain('style="color: #ff0000"');
    });

    test('titre dans h2 avec inline color', () => {
      const html = MarkdownRenderer.formatSectionSeparator('My Section', 'blue');
      expect(html).toContain('<h2 style="color: blue">My Section</h2>');
    });

    test('classe section-separator-with-title', () => {
      const html = MarkdownRenderer.formatSectionSeparator('T', 'red');
      expect(html).toContain(
        'class="section-separator-with-title"'
      );
    });
  });

  // ============================================================
  // formatToolCall — structure complète + badge format
  // ============================================================
  describe('formatToolCall — structure HTML pinnée', () => {
    test('badge format "Appel d\'Outil: ${toolName}"', () => {
      const html = MarkdownRenderer.formatToolCall('read_file', {});
      expect(html).toContain("Appel d'Outil: read_file");
      expect(html).toContain('class="message-badge tool-call"');
    });

    test('message-content contient le paramsTable (pas le toolName directement)', () => {
      const html = MarkdownRenderer.formatToolCall('mytool', { key: 'val' });
      // Le toolName est dans le badge, les params dans content
      expect(html).toContain('tool-parameters-table');
    });
  });
});
