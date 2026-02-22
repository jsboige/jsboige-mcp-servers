/**
 * Tests unitaires pour MarkdownFormatterService
 *
 * Couvre les méthodes statiques qui délèguent aux sous-services :
 * - MarkdownRenderer (formatUserMessage, formatAssistantMessage, etc.)
 * - CSSGenerator (generateCSS, generateInteractiveCSS)
 * - InteractiveFormatter (generateTableOfContents, etc.)
 * - TruncationEngine (truncateToolParameters, etc.)
 *
 * @module services/__tests__/MarkdownFormatterService.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks sous-services (vi.hoisted pour éviter TDZ) ───────────────────

const {
  mockMarkdownRenderer,
  mockCSSGenerator,
  mockInteractiveFormatter,
  mockTruncationEngine,
} = vi.hoisted(() => ({
  mockMarkdownRenderer: {
    formatUserMessage: vi.fn().mockReturnValue('<user>content</user>'),
    formatAssistantMessage: vi.fn().mockReturnValue('<assistant>content</assistant>'),
    formatToolCall: vi.fn().mockReturnValue('<tool-call>content</tool-call>'),
    formatToolResult: vi.fn().mockReturnValue('<tool-result>content</tool-result>'),
    formatConversationHeader: vi.fn().mockReturnValue('<header>content</header>'),
    formatSectionSeparator: vi.fn().mockReturnValue('<separator>---</separator>'),
    formatMetadataTable: vi.fn().mockReturnValue('<table>metadata</table>'),
    formatToolParametersTable: vi.fn().mockReturnValue('<table>params</table>'),
  },
  mockCSSGenerator: {
    generateCSS: vi.fn().mockReturnValue('body { color: red; }'),
    generateInteractiveCSS: vi.fn().mockReturnValue('.interactive { display: flex; }'),
    getTypeColor: vi.fn().mockReturnValue('#000000'),
  },
  mockInteractiveFormatter: {
    generateTableOfContents: vi.fn().mockReturnValue('<toc>toc-content</toc>'),
    generateNavigationAnchors: vi.fn().mockReturnValue('<nav>anchors</nav>'),
    generateMessageCounters: vi.fn().mockReturnValue({ user: 1, assistant: 2, tool_call: 0 }),
    generateInteractiveScript: vi.fn().mockReturnValue('<script>js</script>'),
  },
  mockTruncationEngine: {
    truncateToolParameters: vi.fn().mockReturnValue({ content: 'truncated-params', wasTruncated: false }),
    truncateToolResult: vi.fn().mockReturnValue({ content: 'truncated-result', wasTruncated: true }),
    generateTruncationToggle: vi.fn().mockReturnValue('<button>toggle</button>'),
    generateExpandableContent: vi.fn().mockReturnValue('<details>expandable</details>'),
  },
}));

vi.mock('../markdown-formatter/MarkdownRenderer.js', () => ({
  MarkdownRenderer: mockMarkdownRenderer,
}));

vi.mock('../markdown-formatter/CSSGenerator.js', () => ({
  CSSGenerator: mockCSSGenerator,
}));

vi.mock('../markdown-formatter/InteractiveFormatter.js', () => ({
  InteractiveFormatter: mockInteractiveFormatter,
}));

vi.mock('../markdown-formatter/TruncationEngine.js', () => ({
  TruncationEngine: mockTruncationEngine,
}));

// ─────────────────── import SUT ───────────────────

import { MarkdownFormatterService } from '../MarkdownFormatterService.js';

// ─────────────────── setup ───────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset return values to defaults
  mockMarkdownRenderer.formatUserMessage.mockReturnValue('<user>content</user>');
  mockMarkdownRenderer.formatAssistantMessage.mockReturnValue('<assistant>content</assistant>');
  mockMarkdownRenderer.formatToolCall.mockReturnValue('<tool-call>content</tool-call>');
  mockMarkdownRenderer.formatToolResult.mockReturnValue('<tool-result>content</tool-result>');
  mockMarkdownRenderer.formatConversationHeader.mockReturnValue('<header>content</header>');
  mockMarkdownRenderer.formatSectionSeparator.mockReturnValue('<separator>---</separator>');
  mockMarkdownRenderer.formatMetadataTable.mockReturnValue('<table>metadata</table>');
  mockMarkdownRenderer.formatToolParametersTable.mockReturnValue('<table>params</table>');
  mockCSSGenerator.generateCSS.mockReturnValue('body { color: red; }');
  mockCSSGenerator.generateInteractiveCSS.mockReturnValue('.interactive { display: flex; }');
  mockInteractiveFormatter.generateTableOfContents.mockReturnValue('<toc>toc-content</toc>');
  mockInteractiveFormatter.generateNavigationAnchors.mockReturnValue('<nav>anchors</nav>');
  mockInteractiveFormatter.generateMessageCounters.mockReturnValue({ user: 1, assistant: 2 });
  mockInteractiveFormatter.generateInteractiveScript.mockReturnValue('<script>js</script>');
  mockTruncationEngine.truncateToolParameters.mockReturnValue({ content: 'truncated-params', wasTruncated: false });
  mockTruncationEngine.truncateToolResult.mockReturnValue({ content: 'truncated-result', wasTruncated: true });
  mockTruncationEngine.generateTruncationToggle.mockReturnValue('<button>toggle</button>');
  mockTruncationEngine.generateExpandableContent.mockReturnValue('<details>expandable</details>');
});

// ─────────────────── tests ───────────────────

describe('MarkdownFormatterService', () => {

  // ============================================================
  // CSS generation
  // ============================================================

  describe('generateCSS', () => {
    test('délègue à CSSGenerator.generateCSS', () => {
      const result = MarkdownFormatterService.generateCSS();

      expect(mockCSSGenerator.generateCSS).toHaveBeenCalled();
      expect(result).toBe('body { color: red; }');
    });

    test('délègue avec options fournies', () => {
      const options = { enableAdvancedCSS: false, responsiveDesign: true, syntaxHighlighting: false, animationsEnabled: false, compactMode: true };
      MarkdownFormatterService.generateCSS(options);

      expect(mockCSSGenerator.generateCSS).toHaveBeenCalledWith(options);
    });

    test('generateInteractiveCSS délègue à CSSGenerator', () => {
      const result = MarkdownFormatterService.generateInteractiveCSS();

      expect(mockCSSGenerator.generateInteractiveCSS).toHaveBeenCalled();
      expect(result).toBe('.interactive { display: flex; }');
    });
  });

  // ============================================================
  // Message formatting
  // ============================================================

  describe('formatUserMessage', () => {
    test('délègue à MarkdownRenderer.formatUserMessage', () => {
      const result = MarkdownFormatterService.formatUserMessage('hello world', '2026-01-01T00:00:00Z');

      expect(mockMarkdownRenderer.formatUserMessage).toHaveBeenCalledWith('hello world', '2026-01-01T00:00:00Z');
      expect(result).toBe('<user>content</user>');
    });

    test('fonctionne sans timestamp', () => {
      MarkdownFormatterService.formatUserMessage('content');

      expect(mockMarkdownRenderer.formatUserMessage).toHaveBeenCalledWith('content', undefined);
    });
  });

  describe('formatAssistantMessage', () => {
    test('délègue à MarkdownRenderer.formatAssistantMessage', () => {
      const result = MarkdownFormatterService.formatAssistantMessage('response text');

      expect(mockMarkdownRenderer.formatAssistantMessage).toHaveBeenCalledWith('response text', undefined);
      expect(result).toBe('<assistant>content</assistant>');
    });
  });

  describe('formatToolCall', () => {
    test('délègue à MarkdownRenderer.formatToolCall', () => {
      const params = { file: 'test.ts' };
      const result = MarkdownFormatterService.formatToolCall('read_file', params, '2026-01-01');

      expect(mockMarkdownRenderer.formatToolCall).toHaveBeenCalledWith('read_file', params, '2026-01-01');
      expect(result).toBe('<tool-call>content</tool-call>');
    });
  });

  describe('formatToolResult', () => {
    test('délègue à MarkdownRenderer.formatToolResult', () => {
      const result = MarkdownFormatterService.formatToolResult('read_file', 'file content', '2026-01-01');

      expect(mockMarkdownRenderer.formatToolResult).toHaveBeenCalledWith('read_file', 'file content', '2026-01-01');
      expect(result).toBe('<tool-result>content</tool-result>');
    });
  });

  describe('formatConversationHeader', () => {
    test('délègue à MarkdownRenderer.formatConversationHeader', () => {
      const metadata = { taskId: 'task-1', title: 'Test', messageCount: 5 };
      const result = MarkdownFormatterService.formatConversationHeader(metadata);

      expect(mockMarkdownRenderer.formatConversationHeader).toHaveBeenCalledWith(metadata);
      expect(result).toBe('<header>content</header>');
    });
  });

  describe('formatSectionSeparator', () => {
    test('délègue à MarkdownRenderer.formatSectionSeparator', () => {
      const result = MarkdownFormatterService.formatSectionSeparator('Section Title', '#2563eb');

      expect(mockMarkdownRenderer.formatSectionSeparator).toHaveBeenCalledWith('Section Title', '#2563eb');
      expect(result).toBe('<separator>---</separator>');
    });
  });

  describe('formatMetadataTable', () => {
    test('délègue à MarkdownRenderer.formatMetadataTable', () => {
      const data = { key: 'value', count: 5 };
      const result = MarkdownFormatterService.formatMetadataTable(data);

      expect(mockMarkdownRenderer.formatMetadataTable).toHaveBeenCalledWith(data);
      expect(result).toBe('<table>metadata</table>');
    });
  });

  describe('formatToolParametersTable', () => {
    test('délègue à MarkdownRenderer.formatToolParametersTable', () => {
      const params = { path: '/test', recursive: true };
      const result = MarkdownFormatterService.formatToolParametersTable(params);

      expect(mockMarkdownRenderer.formatToolParametersTable).toHaveBeenCalledWith(params);
      expect(result).toBe('<table>params</table>');
    });
  });

  // ============================================================
  // Interactive features
  // ============================================================

  describe('generateTableOfContents', () => {
    test('délègue à InteractiveFormatter.generateTableOfContents', () => {
      const messages = [{ type: 'user', content: 'msg', timestamp: '2026-01-01' } as any];
      const options = { showCounters: true } as any;
      const result = MarkdownFormatterService.generateTableOfContents(messages, options);

      expect(mockInteractiveFormatter.generateTableOfContents).toHaveBeenCalledWith(messages, options);
      expect(result).toBe('<toc>toc-content</toc>');
    });
  });

  describe('generateNavigationAnchors', () => {
    test('délègue à InteractiveFormatter.generateNavigationAnchors', () => {
      const result = MarkdownFormatterService.generateNavigationAnchors(3, 'tool_call');

      expect(mockInteractiveFormatter.generateNavigationAnchors).toHaveBeenCalledWith(3, 'tool_call');
      expect(result).toBe('<nav>anchors</nav>');
    });
  });

  describe('generateMessageCounters', () => {
    test('délègue à InteractiveFormatter.generateMessageCounters', () => {
      const messages = [{ type: 'user' } as any];
      const result = MarkdownFormatterService.generateMessageCounters(messages);

      expect(mockInteractiveFormatter.generateMessageCounters).toHaveBeenCalledWith(messages);
      expect(result).toEqual({ user: 1, assistant: 2 });
    });
  });

  describe('generateInteractiveScript', () => {
    test('délègue à InteractiveFormatter.generateInteractiveScript', () => {
      const result = MarkdownFormatterService.generateInteractiveScript();

      expect(mockInteractiveFormatter.generateInteractiveScript).toHaveBeenCalled();
      expect(result).toBe('<script>js</script>');
    });
  });

  // ============================================================
  // Truncation
  // ============================================================

  describe('truncateToolParameters', () => {
    test('délègue à TruncationEngine.truncateToolParameters', () => {
      const params = { file: 'test.ts' };
      const options = { maxLength: 100 } as any;
      const result = MarkdownFormatterService.truncateToolParameters(params, options);

      expect(mockTruncationEngine.truncateToolParameters).toHaveBeenCalledWith(params, options);
      expect(result).toEqual({ content: 'truncated-params', wasTruncated: false });
    });

    test('retourne wasTruncated correctement', () => {
      mockTruncationEngine.truncateToolParameters.mockReturnValue({ content: 'x', wasTruncated: true });
      const result = MarkdownFormatterService.truncateToolParameters({});

      expect(result.wasTruncated).toBe(true);
    });
  });

  describe('truncateToolResult', () => {
    test('délègue à TruncationEngine.truncateToolResult', () => {
      const result = MarkdownFormatterService.truncateToolResult('long result text', { maxLength: 50 } as any);

      expect(mockTruncationEngine.truncateToolResult).toHaveBeenCalledWith('long result text', { maxLength: 50 });
      expect(result.content).toBe('truncated-result');
    });
  });

  describe('generateTruncationToggle', () => {
    test('délègue à TruncationEngine.generateTruncationToggle', () => {
      const result = MarkdownFormatterService.generateTruncationToggle('full', 'truncated', 'elem-1');

      expect(mockTruncationEngine.generateTruncationToggle).toHaveBeenCalledWith('full', 'truncated', 'elem-1');
      expect(result).toBe('<button>toggle</button>');
    });
  });

  describe('generateExpandableContent', () => {
    test('délègue à TruncationEngine.generateExpandableContent', () => {
      const result = MarkdownFormatterService.generateExpandableContent('full content', 'summary', 'expand-1');

      expect(mockTruncationEngine.generateExpandableContent).toHaveBeenCalledWith('full content', 'summary', 'expand-1');
      expect(result).toBe('<details>expandable</details>');
    });
  });
});
