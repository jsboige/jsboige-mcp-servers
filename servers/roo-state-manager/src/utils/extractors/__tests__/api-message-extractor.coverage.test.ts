/**
 * Coverage tests for api-message-extractor — uncovered branches after existing suite.
 *
 * Anchored on real source contract (api-message-extractor.ts):
 *   - ApiContentExtractor.extract L31-33 (throw when content falsy/non-string after first guard)
 *   - ApiContentExtractor.debugLog L60-62 (ROO_DEBUG_INSTRUCTIONS === '1' branch)
 *   - ApiContentExtractor.debugError L66-68 (ROO_DEBUG_INSTRUCTIONS === '1' branch)
 *   - ApiTextExtractor.debugLog L134-136 (ROO_DEBUG_INSTRUCTIONS === '1' branch)
 *   - ApiTextExtractor.debugError L140-142 (ROO_DEBUG_INSTRUCTIONS === '1' branch)
 *
 * Companion to api-message-extractor.test.ts (PR #492, MERGED).
 * Tests here target the BRANCHES STILL UNCOVERED after that PR landed:
 *   - v8 report after existing suite: 89.13% Stmts / 79.16% Branch / 100% Funcs
 *   - Uncovered lines: 32, 61, 67, 135, 141
 *
 * Discipline: 0 source touched, add-only *.coverage.test.ts, no test overlap with existing suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiContentExtractor, ApiTextExtractor } from '../api-message-extractor.js';
import { GenericError, GenericErrorCode } from '../../../types/errors.js';

describe('ApiContentExtractor — coverage (uncovered branches after #492)', () => {
    let extractor: ApiContentExtractor;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let originalDebugEnv: string | undefined;

    beforeEach(() => {
        extractor = new ApiContentExtractor();
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        originalDebugEnv = process.env.ROO_DEBUG_INSTRUCTIONS;
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
        if (originalDebugEnv === undefined) {
            delete process.env.ROO_DEBUG_INSTRUCTIONS;
        } else {
            process.env.ROO_DEBUG_INSTRUCTIONS = originalDebugEnv;
        }
    });

    // ============================================================
    // extract L31-33: throw when content falsy / non-string
    // ============================================================
    describe('extract (L31-33) — invalid content field', () => {
        it('DEVRAIT throw GenericError(INVALID_ARGUMENT) quand content est absent du payload', () => {
            // L26-28 first guard passes (content is an object), L30 reads undefined,
            // L31 falsy check fires → throw L32
            const msg = {
                type: 'api_req_started',
                content: { tool: 'newTask', mode: 'code' } // no `content` nor `message` field
            };
            expect(() => extractor.extract(msg)).toThrow(GenericError);
            try {
                extractor.extract(msg);
            } catch (e) {
                expect(e).toBeInstanceOf(GenericError);
                expect((e as GenericError).code).toBe(GenericErrorCode.INVALID_ARGUMENT);
                expect((e as GenericError).message).toBe('Invalid content in message');
            }
        });

        it('DEVRAIT throw GenericError(INVALID_ARGUMENT) quand content est un nombre', () => {
            // L30 picks `content.content || content.message` → 42, typeof !== 'string' → L31 throws
            const msg = {
                type: 'api_req_started',
                content: { tool: 'newTask', content: 42 as any }
            };
            expect(() => extractor.extract(msg)).toThrow(GenericError);
        });
    });

    // ============================================================
    // debugLog L60-62: gated by ROO_DEBUG_INSTRUCTIONS === '1'
    // ============================================================
    describe('debugLog (L60-62) — debug env gate', () => {
        it('DEVRAIT écrire le log de succès quand ROO_DEBUG_INSTRUCTIONS=1', () => {
            // L42-44: successful push triggers debugLog('API content', mode, length) at L44
            process.env.ROO_DEBUG_INSTRUCTIONS = '1';
            const msg = {
                type: 'api_req_started',
                timestamp: '2026-02-22T10:00:00Z',
                content: {
                    tool: 'newTask',
                    mode: 'code',
                    content: 'Implement the user authentication module with JWT'
                }
            };
            const result = extractor.extract(msg);
            expect(result).toHaveLength(1);
            // console.log receives ONE pre-formatted string: `[extractFromMessageFile] ✅ API content: mode=code, len=49`
            const calls = consoleLogSpy.mock.calls.map(c => String(c[0]));
            expect(calls.some(line => line.includes('[extractFromMessageFile] ✅ API content') && line.includes('mode=code'))).toBe(true);
        });

        it('NE DEVRAIT PAS écrire de log quand ROO_DEBUG_INSTRUCTIONS n\'est pas défini', () => {
            // Default (env var unset) → debugLog no-ops (L60 check fails)
            delete process.env.ROO_DEBUG_INSTRUCTIONS;
            const msg = {
                type: 'api_req_started',
                timestamp: '2026-02-22T10:00:00Z',
                content: {
                    tool: 'newTask',
                    mode: 'code',
                    content: 'Implement the user authentication module with JWT'
                }
            };
            extractor.extract(msg);
            expect(consoleLogSpy).not.toHaveBeenCalled();
        });
    });

    // ============================================================
    // debugError L66-68: gated by ROO_DEBUG_INSTRUCTIONS === '1'
    // ============================================================
    describe('debugError (L66-68) — debug env gate', () => {
        it('DEVRAIT appeler debugError via catch quand ROO_DEBUG_INSTRUCTIONS=1', () => {
            // L46-50 catch block: GenericError is thrown then rethrown after debugError logs
            // L67 console.log fired → spy captures it
            process.env.ROO_DEBUG_INSTRUCTIONS = '1';
            const msg = {
                type: 'api_req_started',
                content: { tool: 'newTask', mode: 'code' } // missing content/message → throws at L32
            };
            expect(() => extractor.extract(msg)).toThrow(GenericError);
            const calls = consoleLogSpy.mock.calls.map(c => String(c[0]));
            expect(calls.some(line => line.includes('⚠️ Failed to parse API content message'))).toBe(true);
        });
    });
});

describe('ApiTextExtractor — coverage (uncovered branches after #492)', () => {
    let extractor: ApiTextExtractor;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let originalDebugEnv: string | undefined;

    beforeEach(() => {
        extractor = new ApiTextExtractor();
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        originalDebugEnv = process.env.ROO_DEBUG_INSTRUCTIONS;
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
        if (originalDebugEnv === undefined) {
            delete process.env.ROO_DEBUG_INSTRUCTIONS;
        } else {
            process.env.ROO_DEBUG_INSTRUCTIONS = originalDebugEnv;
        }
    });

    // ============================================================
    // debugLog L134-136: gated by ROO_DEBUG_INSTRUCTIONS === '1'
    // ============================================================
    describe('debugLog (L134-136) — debug env gate (request branch)', () => {
        it('DEVRAIT écrire le log de succès via request pattern quand ROO_DEBUG_INSTRUCTIONS=1 (L106)', () => {
            // L88 → L93 match → L106 debugLog('API text (request)', ...)
            process.env.ROO_DEBUG_INSTRUCTIONS = '1';
            const msg = {
                type: 'api_req_started',
                timestamp: '2026-02-22T10:00:00Z',
                text: JSON.stringify({
                    request: "[new_task in code-simple: 'Run the full test suite and report results']"
                })
            };
            const result = extractor.extract(msg);
            expect(result).toHaveLength(1);
            const calls = consoleLogSpy.mock.calls.map(c => String(c[0]));
            // mode 'code-simple' normalized to 'codesimple' by cleanMode() in createInstruction (L56 of message-pattern-extractors)
            expect(calls.some(line => line.includes('[extractFromMessageFile] ✅ API text (request)') && line.includes('mode=codesimple'))).toBe(true);
        });

        it('DEVRAIT écrire le log de succès via tool=newTask branch quand ROO_DEBUG_INSTRUCTIONS=1 (L119)', () => {
            // L109 → L117 → L119 debugLog('API text', ...)
            process.env.ROO_DEBUG_INSTRUCTIONS = '1';
            const msg = {
                type: 'api_req_started',
                timestamp: '2026-02-22T10:00:00Z',
                text: JSON.stringify({
                    tool: 'newTask',
                    mode: 'code',
                    content: 'Build the notification service for alerts'
                })
            };
            const result = extractor.extract(msg);
            expect(result).toHaveLength(1);
            const calls = consoleLogSpy.mock.calls.map(c => String(c[0]));
            expect(calls.some(line => line.includes('[extractFromMessageFile] ✅ API text') && line.includes('mode=code'))).toBe(true);
        });
    });

    // ============================================================
    // debugError L140-142: gated by ROO_DEBUG_INSTRUCTIONS === '1'
    // ============================================================
    describe('debugError (L140-142) — debug env gate', () => {
        it('DEVRAIT appeler debugError via catch quand JSON.parse throw et ROO_DEBUG_INSTRUCTIONS=1', () => {
            // L85 JSON.parse throws on malformed input → L122 catch → L123 debugError
            process.env.ROO_DEBUG_INSTRUCTIONS = '1';
            const msg = { type: 'api_req_started', text: 'not valid json {{{' };
            const result = extractor.extract(msg);
            expect(result).toEqual([]);
            const calls = consoleLogSpy.mock.calls.map(c => String(c[0]));
            expect(calls.some(line => line.includes('⚠️ Failed to parse API text message'))).toBe(true);
        });
    });
});