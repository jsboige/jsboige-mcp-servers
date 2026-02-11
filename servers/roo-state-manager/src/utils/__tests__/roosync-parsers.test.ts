/**
 * Tests unitaires pour roosync-parsers
 *
 * Couvre :
 * - parseRoadmapMarkdownContent : parsing de blocs de décision Markdown
 * - parseDashboardJsonContent : parsing de dashboard JSON
 * - parseConfigJsonContent : parsing de config JSON
 * - filterDecisionsByStatus / filterDecisionsByMachine / findDecisionById
 * - RooSyncParseError
 * - parseDecisionBlock (via parseRoadmapMarkdownContent) : validation champs
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseRoadmapMarkdownContent,
  parseDashboardJsonContent,
  parseConfigJsonContent,
  filterDecisionsByStatus,
  filterDecisionsByMachine,
  findDecisionById,
  RooSyncParseError,
  type RooSyncDecision,
  type RooSyncDashboard,
} from '../roosync-parsers.js';

// === Fixtures ===

function createDecisionMarkdown(overrides?: Record<string, string>): string {
  const fields = {
    id: 'dec-001',
    title: 'Update config',
    status: 'pending',
    type: 'config',
    path: '/etc/roo.json',
    sourceMachine: 'myia-ai-01',
    targetMachines: 'myia-po-2023, myia-po-2024',
    createdAt: '2026-02-10T10:00:00Z',
    updatedAt: '2026-02-10T12:00:00Z',
    createdBy: 'admin',
    details: 'Change timeout to 30s',
    ...overrides,
  };

  return `<!-- DECISION_BLOCK_START -->
**ID:** \`${fields.id}\`
**Titre:** ${fields.title}
**Statut:** ${fields.status}
**Type:** ${fields.type}
**Chemin:** \`${fields.path}\`
**Machine Source:** ${fields.sourceMachine}
**Machines Cibles:** ${fields.targetMachines}
**Créé:** ${fields.createdAt}
**Mis à jour:** ${fields.updatedAt}
**Créé par:** ${fields.createdBy}
**Détails:** ${fields.details}
<!-- DECISION_BLOCK_END -->`;
}

function createDecision(overrides?: Partial<RooSyncDecision>): RooSyncDecision {
  return {
    id: 'dec-001',
    title: 'Test decision',
    status: 'pending',
    type: 'config',
    sourceMachine: 'myia-ai-01',
    targetMachines: ['myia-po-2023'],
    createdAt: '2026-02-10T10:00:00Z',
    ...overrides,
  };
}

function createDashboardJson(overrides?: Partial<RooSyncDashboard>): RooSyncDashboard {
  return {
    version: '2.3',
    lastUpdate: '2026-02-10T10:00:00Z',
    lastSync: '2026-02-10T09:00:00Z',
    overallStatus: 'synced',
    status: 'synced',
    machines: {
      'myia-ai-01': {
        lastSync: '2026-02-10T09:00:00Z',
        status: 'online',
        diffsCount: 0,
        pendingDecisions: 0,
      },
    },
    ...overrides,
  };
}

// === Tests ===

describe('roosync-parsers', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // === parseRoadmapMarkdownContent ===

  describe('parseRoadmapMarkdownContent', () => {
    it('should parse a single decision block', () => {
      const content = createDecisionMarkdown();
      const decisions = parseRoadmapMarkdownContent(content);

      expect(decisions).toHaveLength(1);
      expect(decisions[0].id).toBe('dec-001');
      expect(decisions[0].title).toBe('Update config');
      expect(decisions[0].status).toBe('pending');
      expect(decisions[0].type).toBe('config');
      expect(decisions[0].sourceMachine).toBe('myia-ai-01');
    });

    it('should parse multiple decision blocks', () => {
      const content = [
        createDecisionMarkdown({ id: 'dec-001', title: 'First' }),
        createDecisionMarkdown({ id: 'dec-002', title: 'Second' }),
        createDecisionMarkdown({ id: 'dec-003', title: 'Third' }),
      ].join('\n\n');

      const decisions = parseRoadmapMarkdownContent(content);
      expect(decisions).toHaveLength(3);
      expect(decisions[0].id).toBe('dec-001');
      expect(decisions[1].id).toBe('dec-002');
      expect(decisions[2].id).toBe('dec-003');
    });

    it('should extract path from backtick-quoted field', () => {
      const content = createDecisionMarkdown({ path: '/my/custom/path.json' });
      const decisions = parseRoadmapMarkdownContent(content);

      expect(decisions[0].path).toBe('/my/custom/path.json');
    });

    it('should parse target machines as comma-separated list', () => {
      const content = createDecisionMarkdown({
        targetMachines: 'machine-a, machine-b, machine-c',
      });
      const decisions = parseRoadmapMarkdownContent(content);

      expect(decisions[0].targetMachines).toEqual(['machine-a', 'machine-b', 'machine-c']);
    });

    it('should handle empty target machines', () => {
      const content = `<!-- DECISION_BLOCK_START -->
**ID:** \`dec-empty\`
**Titre:** No targets
**Statut:** pending
**Machine Source:** myia-ai-01
<!-- DECISION_BLOCK_END -->`;

      const decisions = parseRoadmapMarkdownContent(content);
      expect(decisions[0].targetMachines).toEqual([]);
    });

    it('should parse all valid statuses', () => {
      const statuses = ['pending', 'approved', 'rejected', 'applied', 'rolled_back'];
      for (const status of statuses) {
        const content = createDecisionMarkdown({ status });
        const decisions = parseRoadmapMarkdownContent(content);
        expect(decisions[0].status).toBe(status);
      }
    });

    it('should default to pending for invalid status', () => {
      const content = createDecisionMarkdown({ status: 'INVALID_STATUS' });
      const decisions = parseRoadmapMarkdownContent(content);
      expect(decisions[0].status).toBe('pending');
    });

    it('should parse all valid types', () => {
      const types = ['config', 'file', 'setting'];
      for (const type of types) {
        const content = createDecisionMarkdown({ type });
        const decisions = parseRoadmapMarkdownContent(content);
        expect(decisions[0].type).toBe(type);
      }
    });

    it('should default to config for invalid type', () => {
      const content = createDecisionMarkdown({ type: 'UNKNOWN' });
      const decisions = parseRoadmapMarkdownContent(content);
      expect(decisions[0].type).toBe('config');
    });

    it('should return empty array for content without blocks', () => {
      const content = '# Just a regular markdown file\n\nNo decisions here.';
      const decisions = parseRoadmapMarkdownContent(content);
      expect(decisions).toHaveLength(0);
    });

    it('should return empty array for empty string', () => {
      const decisions = parseRoadmapMarkdownContent('');
      expect(decisions).toHaveLength(0);
    });

    it('should skip blocks missing required fields', () => {
      const content = `<!-- DECISION_BLOCK_START -->
**Titre:** Missing ID
**Statut:** pending
<!-- DECISION_BLOCK_END -->`;

      const decisions = parseRoadmapMarkdownContent(content);
      expect(decisions).toHaveLength(0);
    });

    it('should skip blocks missing source machine', () => {
      const content = `<!-- DECISION_BLOCK_START -->
**ID:** \`dec-no-source\`
**Titre:** No source
**Statut:** pending
<!-- DECISION_BLOCK_END -->`;

      const decisions = parseRoadmapMarkdownContent(content);
      expect(decisions).toHaveLength(0);
    });

    it('should extract optional fields (updatedAt, createdBy, details)', () => {
      const content = createDecisionMarkdown({
        updatedAt: '2026-03-01T00:00:00Z',
        createdBy: 'test-user',
        details: 'Some detailed description',
      });
      const decisions = parseRoadmapMarkdownContent(content);

      expect(decisions[0].updatedAt).toBe('2026-03-01T00:00:00Z');
      expect(decisions[0].createdBy).toBe('test-user');
      expect(decisions[0].details).toBe('Some detailed description');
    });

    it('should handle blocks with surrounding text', () => {
      const content = `# RooSync Roadmap

Some intro text.

${createDecisionMarkdown({ id: 'embedded-dec' })}

Some more text between decisions.

${createDecisionMarkdown({ id: 'embedded-dec-2' })}

Footer text.`;

      const decisions = parseRoadmapMarkdownContent(content);
      expect(decisions).toHaveLength(2);
      expect(decisions[0].id).toBe('embedded-dec');
      expect(decisions[1].id).toBe('embedded-dec-2');
    });
  });

  // === parseDashboardJsonContent ===

  describe('parseDashboardJsonContent', () => {
    it('should parse valid dashboard JSON', () => {
      const dashboard = createDashboardJson();
      const result = parseDashboardJsonContent(JSON.stringify(dashboard));

      expect(result.version).toBe('2.3');
      expect(result.overallStatus).toBe('synced');
      expect(result.machines['myia-ai-01'].status).toBe('online');
    });

    it('should parse dashboard with stats', () => {
      const dashboard = createDashboardJson({
        stats: {
          totalDiffs: 5,
          totalDecisions: 10,
          appliedDecisions: 8,
          pendingDecisions: 2,
        },
      });
      const result = parseDashboardJsonContent(JSON.stringify(dashboard));

      expect(result.stats!.totalDiffs).toBe(5);
      expect(result.stats!.pendingDecisions).toBe(2);
    });

    it('should parse dashboard with machinesArray', () => {
      const dashboard = createDashboardJson({
        machinesArray: [
          { id: 'machine-1', status: 'online', lastSync: '2026-01-01T00:00:00Z', diffsCount: 0, pendingDecisions: 0 },
        ],
      });
      const result = parseDashboardJsonContent(JSON.stringify(dashboard));

      expect(result.machinesArray).toHaveLength(1);
      expect(result.machinesArray![0].id).toBe('machine-1');
    });

    it('should throw for missing version field', () => {
      const invalid = { machines: {} }; // no version
      expect(() => parseDashboardJsonContent(JSON.stringify(invalid))).toThrow(RooSyncParseError);
    });

    it('should throw for missing machines field', () => {
      const invalid = { version: '1.0' }; // no machines
      expect(() => parseDashboardJsonContent(JSON.stringify(invalid))).toThrow(RooSyncParseError);
    });

    it('should throw for invalid JSON', () => {
      expect(() => parseDashboardJsonContent('not json')).toThrow(RooSyncParseError);
    });

    it('should throw for empty string', () => {
      expect(() => parseDashboardJsonContent('')).toThrow(RooSyncParseError);
    });

    it('should handle BOM in JSON content', () => {
      const dashboard = createDashboardJson();
      const withBOM = '\uFEFF' + JSON.stringify(dashboard);
      const result = parseDashboardJsonContent(withBOM);
      expect(result.version).toBe('2.3');
    });
  });

  // === parseConfigJsonContent ===

  describe('parseConfigJsonContent', () => {
    it('should parse valid config JSON', () => {
      const config = { setting1: 'value1', setting2: 42 };
      const result = parseConfigJsonContent(JSON.stringify(config));

      expect(result.setting1).toBe('value1');
      expect(result.setting2).toBe(42);
    });

    it('should throw for invalid JSON', () => {
      expect(() => parseConfigJsonContent('{ invalid')).toThrow(RooSyncParseError);
    });

    it('should handle BOM in content', () => {
      const config = { test: true };
      const withBOM = '\uFEFF' + JSON.stringify(config);
      const result = parseConfigJsonContent(withBOM);
      expect(result.test).toBe(true);
    });

    it('should parse nested objects', () => {
      const config = { level1: { level2: { value: 'deep' } } };
      const result = parseConfigJsonContent(JSON.stringify(config));
      expect(result.level1.level2.value).toBe('deep');
    });

    it('should parse arrays', () => {
      const config = { items: [1, 2, 3] };
      const result = parseConfigJsonContent(JSON.stringify(config));
      expect(result.items).toEqual([1, 2, 3]);
    });
  });

  // === filterDecisionsByStatus ===

  describe('filterDecisionsByStatus', () => {
    const decisions: RooSyncDecision[] = [
      createDecision({ id: '1', status: 'pending' }),
      createDecision({ id: '2', status: 'approved' }),
      createDecision({ id: '3', status: 'pending' }),
      createDecision({ id: '4', status: 'applied' }),
      createDecision({ id: '5', status: 'rejected' }),
    ];

    it('should filter by pending status', () => {
      const result = filterDecisionsByStatus(decisions, 'pending');
      expect(result).toHaveLength(2);
      expect(result.map(d => d.id)).toEqual(['1', '3']);
    });

    it('should filter by approved status', () => {
      const result = filterDecisionsByStatus(decisions, 'approved');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });

    it('should return empty for non-matching status', () => {
      const result = filterDecisionsByStatus(decisions, 'rolled_back');
      expect(result).toHaveLength(0);
    });

    it('should return empty for empty input', () => {
      const result = filterDecisionsByStatus([], 'pending');
      expect(result).toHaveLength(0);
    });
  });

  // === filterDecisionsByMachine ===

  describe('filterDecisionsByMachine', () => {
    const decisions: RooSyncDecision[] = [
      createDecision({ id: '1', targetMachines: ['machine-a'] }),
      createDecision({ id: '2', targetMachines: ['machine-b'] }),
      createDecision({ id: '3', targetMachines: ['machine-a', 'machine-b'] }),
      createDecision({ id: '4', targetMachines: ['all'] }),
      createDecision({ id: '5', targetMachines: [] }),
    ];

    it('should filter by specific machine', () => {
      const result = filterDecisionsByMachine(decisions, 'machine-a');
      expect(result.map(d => d.id)).toEqual(['1', '3', '4', '5']);
    });

    it('should include decisions targeting "all"', () => {
      const result = filterDecisionsByMachine(decisions, 'unknown-machine');
      expect(result.map(d => d.id)).toEqual(['4', '5']);
    });

    it('should include decisions with empty target (broadcast)', () => {
      const result = filterDecisionsByMachine(decisions, 'any-machine');
      expect(result.some(d => d.id === '5')).toBe(true);
    });

    it('should return empty for empty input', () => {
      const result = filterDecisionsByMachine([], 'machine-a');
      expect(result).toHaveLength(0);
    });
  });

  // === findDecisionById ===

  describe('findDecisionById', () => {
    const decisions: RooSyncDecision[] = [
      createDecision({ id: 'dec-001' }),
      createDecision({ id: 'dec-002' }),
      createDecision({ id: 'dec-003' }),
    ];

    it('should find existing decision', () => {
      const result = findDecisionById(decisions, 'dec-002');
      expect(result).toBeDefined();
      expect(result!.id).toBe('dec-002');
    });

    it('should return undefined for non-existent ID', () => {
      const result = findDecisionById(decisions, 'dec-999');
      expect(result).toBeUndefined();
    });

    it('should return undefined for empty array', () => {
      const result = findDecisionById([], 'dec-001');
      expect(result).toBeUndefined();
    });
  });

  // === RooSyncParseError ===

  describe('RooSyncParseError', () => {
    it('should create error with message prefix', () => {
      const error = new RooSyncParseError('test error');
      expect(error.message).toContain('[RooSync Parse]');
      expect(error.message).toContain('test error');
      expect(error.name).toBe('RooSyncParseError');
    });

    it('should store filePath', () => {
      const error = new RooSyncParseError('test', '/path/to/file.md');
      expect(error.filePath).toBe('/path/to/file.md');
    });

    it('should handle undefined filePath', () => {
      const error = new RooSyncParseError('test');
      expect(error.filePath).toBeUndefined();
    });

    it('should be instanceof Error', () => {
      const error = new RooSyncParseError('test');
      expect(error).toBeInstanceOf(Error);
    });
  });
});
