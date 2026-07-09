/**
 * Coverage gaps pour ContentClassifier
 *
 * Cible les branches/lignes non couvertes par ContentClassifier.test.ts (base 92.7% Stmts / 93% Branch).
 * Domaines couverts ici :
 * - classifyConversationContent : validation startIndex<0 (throw L42-43), endIndex omis (default L36),
 *   filtrage sequence non-Message (branch L30)
 * - parseToolParameters : garde erreur runtime (catch L212-215)
 * - extractToolBracketSummaryFromResult : parsing JSON serverName/toolName/arguments (L335-348),
 *   outer catch JSON invalide (L356-358)
 *
 * NON couvert (anti-busy-work) :
 * - L429-432 (extraction <use_mcp_tool server_name>) = DEAD CODE : use_mcp_tool est dans commonTools
 *   (L416), la boucle extractFirstToolName (L421) retourne toujours 'use_mcp_tool' avant L429.
 * - L165 (tagMatch ? ... : 'unknown_tool') = branche défensive irréaliste (l'outer regex L157 exige
 *   déjà un tag, donc tagMatch ne peut être null ici).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContentClassifier } from '../ContentClassifier.js';
import type { ConversationSkeleton, MessageSkeleton } from '../../../types/conversation.js';
import type { SummaryOptions } from '../../../types/trace-summary.js';

// ---------- Helpers (mirror base test) ----------

function makeMessage(role: 'user' | 'assistant', content: string): MessageSkeleton {
    return { role, content, timestamp: '2026-01-01T00:00:00Z', isTruncated: false };
}

function makeSkeleton(sequence: any[], taskId = 'test-task-001'): ConversationSkeleton {
    return {
        taskId,
        metadata: {
            title: 'Test conversation',
            lastActivity: '2026-01-01T00:00:00Z',
            createdAt: '2026-01-01T00:00:00Z',
            messageCount: sequence.length,
            actionCount: 0,
            totalSize: 1000,
        },
        sequence,
    };
}

describe('ContentClassifier — coverage gaps', () => {
    let classifier: ContentClassifier;

    beforeEach(() => {
        classifier = new ContentClassifier();
    });

    // ---------- classifyConversationContent : L42-43, branches L30/L36 ----------

    describe('classifyConversationContent — range validation', () => {
        it('throws when startIndex < 0 (L42-43)', () => {
            const conv = makeSkeleton([makeMessage('user', 'hello')]);
            const options: SummaryOptions = { startIndex: -1, endIndex: 5 };
            expect(() => classifier.classifyConversationContent(conv, options))
                .toThrow(/Invalid startIndex.*must be >= 0/);
        });

        it('defaults endIndex to sequence length when only startIndex given (branch L36)', () => {
            const conv = makeSkeleton([
                makeMessage('user', 'one'),
                makeMessage('assistant', 'two'),
                makeMessage('user', 'three'),
            ]);
            // startIndex=2, endIndex omis → rawEnd = sequence.length (3). startIdx=1, endIdx=3 → 2 msgs.
            const result = classifier.classifyConversationContent(conv, { startIndex: 2 });
            expect(result).toHaveLength(2);
            expect(result[0].content).toBe('two');
        });

        it('filters out non-Message sequence items (branch L30)', () => {
            // Items sans 'role'/'content' (metadata-only entries) doivent être filtrés.
            const conv = makeSkeleton([
                makeMessage('user', 'real message'),
                { someMetaField: 'not a message' } as any,
                makeMessage('assistant', 'another real'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result).toHaveLength(2);
            expect(result.every(r => r.content === 'real message' || r.content === 'another real')).toBe(true);
        });
    });

    // ---------- parseToolParameters : catch L212-215 (runtime error guard) ----------

    describe('parseToolParameters — error guard', () => {
        it('catches runtime error on non-string input and returns null (L212-215)', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            // L'appel .match() sur undefined lève un TypeError → catch (L212) → console.warn + return null.
            const result = (classifier as any).parseToolParameters(undefined);
            expect(result).toBeNull();
            expect(warnSpy).toHaveBeenCalledWith('Failed to parse tool parameters:', expect.any(TypeError));
            warnSpy.mockRestore();
        });
    });

    // ---------- extractToolBracketSummaryFromResult : JSON serverName/toolName/arguments (L335-348) ----------

    describe('extractToolBracketSummaryFromResult — tool JSON with server/tool + arguments', () => {
        it('summarises serverName/toolName + short args.path (L333-341)', () => {
            const content = JSON.stringify({
                tool: 'call',
                serverName: 'myserver',
                toolName: 'query',
                arguments: JSON.stringify({ path: '/short/path' }),
            });
            const result = classifier.extractToolBracketSummaryFromResult(content);
            expect(result).toBe("myserver/query for '/short/path'");
        });

        it('truncates long args.path (>30 chars → ... + last 27) (L339-340)', () => {
            const longPath = '/' + 'a'.repeat(40); // 41 chars > 30
            const content = JSON.stringify({
                tool: 'call',
                serverName: 'srv',
                toolName: 'tn',
                arguments: JSON.stringify({ path: longPath }),
            });
            const result = classifier.extractToolBracketSummaryFromResult(content);
            expect(result).toMatch(/^srv\/tn for '\.\.\./); // préfixe '...' de troncature
            expect(result!.length).toBeLessThan(`srv/tn for '${longPath}'`.length);
        });

        it('summarises args.taskId when no args.path (L342-343)', () => {
            const content = JSON.stringify({
                tool: 'call',
                serverName: 'srv',
                toolName: 'tn',
                arguments: JSON.stringify({ taskId: 'abcdefgh12345' }),
            });
            const result = classifier.extractToolBracketSummaryFromResult(content);
            expect(result).toBe("srv/tn for task 'abcdefgh...'");
        });

        it('ignores malformed arguments string (inner catch L345-347) → summary stays server/tool', () => {
            const content = JSON.stringify({
                tool: 'call',
                serverName: 'srv',
                toolName: 'tn',
                arguments: '{not valid json',
            });
            const result = classifier.extractToolBracketSummaryFromResult(content);
            expect(result).toBe('srv/tn');
        });

        it('returns null on invalid top-level JSON (outer catch L356-358)', () => {
            // textContent = "{not valid json}" → jsonMatch OK mais JSON.parse lance → catch → null.
            const result = classifier.extractToolBracketSummaryFromResult('{not valid json}');
            expect(result).toBeNull();
        });
    });
});
