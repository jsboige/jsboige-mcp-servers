/**
 * Team Pipeline Stage Tests (#1853)
 *
 * Tests the Team pipeline stage functionality for dashboard messages.
 * @module tools/roosync/__tests__/dashboard-team-pipeline
 * @issue #1853
 */

import { describe, it, expect } from 'vitest';
import {
  TeamStageSchema,
  IntercomMessageSchema,
  DashboardArgsSchema
} from '../dashboard-schemas.js';

describe('Team Pipeline Stages (#1853)', () => {
  describe('TeamStageSchema', () => {
    const validStages = [
      'team-plan',
      'team-prd',
      'team-exec',
      'team-verify',
      'team-fix',
      'none'
    ] as const;

    it('should accept all valid team stages', () => {
      validStages.forEach(stage => {
        const result = TeamStageSchema.safeParse(stage);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(stage);
        }
      });
    });

    it('should reject invalid team stages', () => {
      const invalidStages = [
        'invalid-stage',
        'TEAM-PLAN',  // case sensitive
        'team-planning',
        '',
        null,
        undefined
      ];

      invalidStages.forEach(stage => {
        const result = TeamStageSchema.safeParse(stage);
        expect(result.success).toBe(false);
      });
    });

    it('should accept optional teamStage in IntercomMessage', () => {
      const messageWithStage = {
        id: 'ic-20260430-test',
        timestamp: '2026-04-30T21:00:00Z',
        author: {
          machineId: 'myia-po-2026',
          workspace: 'roo-extensions'
        },
        content: 'Test message',
        teamStage: 'team-exec'
      };

      const result = IntercomMessageSchema.safeParse(messageWithStage);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.teamStage).toBe('team-exec');
      }
    });

    it('should accept IntercomMessage without teamStage', () => {
      const messageWithoutStage = {
        id: 'ic-20260430-test',
        timestamp: '2026-04-30T21:00:00Z',
        author: {
          machineId: 'myia-po-2026',
          workspace: 'roo-extensions'
        },
        content: 'Test message'
      };

      const result = IntercomMessageSchema.safeParse(messageWithoutStage);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.teamStage).toBeUndefined();
      }
    });
  });

  describe('DashboardArgsSchema teamStage parameter', () => {
    it('should accept teamStage in append action', () => {
      const argsWithTeamStage = {
        action: 'append' as const,
        type: 'workspace' as const,
        content: 'Test content',
        teamStage: 'team-plan'
      };

      const result = DashboardArgsSchema.safeParse(argsWithTeamStage);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.teamStage).toBe('team-plan');
      }
    });

    it('should accept append without teamStage (backward compatibility)', () => {
      const argsWithoutTeamStage = {
        action: 'append' as const,
        type: 'workspace' as const,
        content: 'Test content'
      };

      const result = DashboardArgsSchema.safeParse(argsWithoutTeamStage);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.teamStage).toBeUndefined();
      }
    });

    it('should reject invalid teamStage values', () => {
      const argsWithInvalidStage = {
        action: 'append' as const,
        type: 'workspace' as const,
        content: 'Test content',
        teamStage: 'invalid-stage'
      };

      const result = DashboardArgsSchema.safeParse(argsWithInvalidStage);
      expect(result.success).toBe(false);
    });
  });

  describe('Team pipeline stage transitions', () => {
    it('should define valid stage transitions', () => {
      // Define valid transitions based on #1853
      const validTransitions: Record<string, string[]> = {
        'team-plan': ['team-prd', 'team-exec'],
        'team-prd': ['team-exec'],
        'team-exec': ['team-verify'],
        'team-verify': ['team-fix'],  // or DONE if verification passes
        'team-fix': ['team-verify'],  // loop back to verify
        'none': []  // terminal, for simple tasks
      };

      // Verify all stages are covered
      const allStages = ['team-plan', 'team-prd', 'team-exec', 'team-verify', 'team-fix', 'none'];
      expect(Object.keys(validTransitions).sort()).toEqual(allStages.sort());

      // Verify transitions are valid stages
      Object.entries(validTransitions).forEach(([from, toList]) => {
        toList.forEach(to => {
          expect(allStages).toContain(to);
        });
      });
    });
  });

  describe('Complexity threshold', () => {
    it('should define complexity rules', () => {
      // From #1853: Complex task = (>3 files) OR (>50 LOC)
      const isComplex = (fileCount: number, locCount: number): boolean => {
        return fileCount > 3 || locCount > 50;
      };

      // Test cases
      expect(isComplex(4, 10)).toBe(true);   // >3 files
      expect(isComplex(2, 60)).toBe(true);   // >50 LOC
      expect(isComplex(5, 100)).toBe(true);  // both
      expect(isComplex(3, 30)).toBe(false);  // simple
      expect(isComplex(1, 10)).toBe(false);  // very simple
    });
  });
});
