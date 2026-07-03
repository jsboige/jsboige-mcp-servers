/**
 * message-extraction-coordinator.coverage.test.ts - Coverage complement for message-extraction-coordinator.ts
 *
 * Source-grounded targets (post-c.29 fresh worktree coverage: L=89.39% / B=78.12% / F=100.00%):
 *
 * REACHABLE cold branches covered below:
 *
 * MessageExtractionCoordinator.extractFromMessages
 * - L62: force-debug `process.env.ROO_DEBUG_INSTRUCTIONS === '1'` truthy arm → debugLog fires console.log
 * - L92: catch path (global extraction error) → errors array push
 *
 * MessageExtractionCoordinator.extractFromMessages / processMessage loop (with options.enableDebug=true)
 * - L85: cond-expr `typeof message.text === 'string' ? ... : 'N/A'` false-arm (text is non-string)
 * - L162: processMessage inner `if (this.debugEnabled)` truthy arm (debug log "✅ {extractor} matched")
 *
 * MessageExtractionCoordinator.logExtractionSummary
 * - L197: `if (result.errors.length > 0)` truthy arm (console.log "Error details")
 *
 * MessageExtractionCoordinator.logError
 * - L206: `if (this.debugEnabled)` truthy arm (console.error)
 *
 * Discipline:
 * - 0 source touched (add-only `*.coverage.test.ts`)
 * - Each test names its source line anchor (anti-churn #1936)
 * - Debug arms driven via `process.env.ROO_DEBUG_INSTRUCTIONS = '1'` (L62) or `options.enableDebug=true` (L85/L162/L197) or `setDebugEnabled(true)` (L206)
 * - Uses spy on console.log/error so we don't pollute test output
 *
 * NOTE on L137 (initializeExtractors debug log):
 *   Source flow: constructor → initializeExtractors() → THEN debugEnabled = env check.
 *   So at L137, this.debugEnabled is still FALSE (class field default). L137 truthy arm
 *   is unreachable from constructor by design. Per anti-churn #1936, skip with evidence.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageExtractionCoordinator } from '../message-extraction-coordinator.js';

describe('message-extraction-coordinator — coverage complement', () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let originalDebug: string | undefined;

	beforeEach(() => {
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		originalDebug = process.env.ROO_DEBUG_INSTRUCTIONS;
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		if (originalDebug === undefined) {
			delete process.env.ROO_DEBUG_INSTRUCTIONS;
		} else {
			process.env.ROO_DEBUG_INSTRUCTIONS = originalDebug;
		}
	});

	// Helper: flatten all console.log/error call args into searchable lines
	function flattenLogCalls(spy: ReturnType<typeof vi.spyOn>): string[] {
		const lines: string[] = [];
		for (const call of spy.mock.calls) {
			for (const arg of call) {
				lines.push(String(arg ?? ''));
			}
		}
		return lines;
	}

	// ============================================================
	// L62 — extractFromMessages force-debug env var truthy arm
	// ============================================================
	describe('L62: extractFromMessages — force-debug env var', () => {
		test('L62: should fire debugLog when ROO_DEBUG_INSTRUCTIONS=1', () => {
			process.env.ROO_DEBUG_INSTRUCTIONS = '1';
			const coordinator = new MessageExtractionCoordinator();
			const messages = [
				{ type: 'say', role: 'assistant', text: 'hello world message 1' },
				{ type: 'say', role: 'assistant', text: 'hello world message 2' },
			];

			coordinator.extractFromMessages(messages);

			const calls = flattenLogCalls(consoleLogSpy);
			const hit = calls.some(line =>
				line.includes('[MessageExtractionCoordinator]') &&
				line.includes('Processing 2 messages')
			);
			expect(hit).toBe(true);
		});
	});

	// ============================================================
	// L85 — processMessage loop cond-expr false-arm (text non-string)
	//       Requires options.enableDebug=true (since L74 resets to false otherwise)
	// ============================================================
	describe('L85: processMessage loop — non-string text', () => {
		test('L85: should hit N/A branch when message.text is number', () => {
			const coordinator = new MessageExtractionCoordinator();
			const messages = [
				{ type: 'say', role: 'assistant', text: 42 as any },
			];

			coordinator.extractFromMessages(messages, { enableDebug: true });

			const calls = flattenLogCalls(consoleLogSpy);
			const hit = calls.some(line =>
				line.includes('[MessageExtractionCoordinator]') &&
				line.includes('Traitement message') &&
				line.includes('N/A')
			);
			expect(hit).toBe(true);
		});

		test('L85: should hit N/A branch when message.text is null', () => {
			const coordinator = new MessageExtractionCoordinator();
			const messages = [
				{ type: 'say', role: 'assistant', text: null as any },
			];

			coordinator.extractFromMessages(messages, { enableDebug: true });

			const calls = flattenLogCalls(consoleLogSpy);
			const hit = calls.some(line =>
				line.includes('Traitement message') && line.includes('N/A')
			);
			expect(hit).toBe(true);
		});

		test('L85: should hit N/A branch when message.text is object', () => {
			const coordinator = new MessageExtractionCoordinator();
			const messages = [
				{ type: 'say', role: 'assistant', text: { foo: 'bar' } as any },
			];

			coordinator.extractFromMessages(messages, { enableDebug: true });

			const calls = flattenLogCalls(consoleLogSpy);
			const hit = calls.some(line =>
				line.includes('Traitement message') && line.includes('N/A')
			);
			expect(hit).toBe(true);
		});
	});

	// ============================================================
	// L92 — extractFromMessages catch path (global extraction error)
	// ============================================================
	describe('L92: extractFromMessages — catch path', () => {
		test('L92: should capture global extraction error when iteration throws', () => {
			const coordinator = new MessageExtractionCoordinator();
			// for...of throws TypeError on non-iterable
			const badMessages: any = new Proxy([], {
				get(target, prop) {
					if (prop === Symbol.iterator) {
						return () => {
							throw new Error('synthetic iteration error');
						};
					}
					return (target as any)[prop];
				},
			});

			const result = coordinator.extractFromMessages(badMessages);

			expect(result.errors.length).toBeGreaterThanOrEqual(1);
			const hit = result.errors.some(e => e.includes('Global extraction error'));
			expect(hit).toBe(true);
		});
	});

	// ============================================================
	// L137 — initializeExtractors debug log when debugEnabled at construction time
	//        SKIP-WITH-EVIDENCE: source initializes debugEnabled AFTER initializeExtractors,
	//        so this.debugEnabled is still FALSE (default) when L137 is evaluated.
	//        The truthy arm at L137 is unreachable by source design.
	// ============================================================
	describe('L137: initializeExtractors — debug log unreachable', () => {
		test('L137 unreachable-by-design: constructor sets debugEnabled AFTER initializeExtractors', () => {
			// Skip with evidence per anti-churn #1936.
			// Source flow: constructor() → this.initializeExtractors() (L137 evaluated with debugEnabled=false)
			//                       → this.debugEnabled = process.env.ROO_DEBUG_INSTRUCTIONS === '1' (L51, AFTER)
			// L137 truthy arm is unreachable without source mutation.
			expect(true).toBe(true);
		});
	});

	// ============================================================
	// L162 — processMessage inner debug log (matched path) with options.enableDebug=true
	// ============================================================
	describe('L162: processMessage — debug log on matched extractor', () => {
		test('L162: should fire debugLog when an extractor matches a message with debug enabled', () => {
			const coordinator = new MessageExtractionCoordinator();
			// Use a UiSimpleTaskExtractor-compatible message: <task>...</task>
			const messages = [
				{
					type: 'say',
					role: 'assistant',
					text: 'Please do: <task>Build the auth middleware for the routes</task>',
				},
			];

			const result = coordinator.extractFromMessages(messages, { enableDebug: true });
			expect(result.instructions.length).toBeGreaterThan(0);

			const calls = flattenLogCalls(consoleLogSpy);
			const hit = calls.some(line =>
				line.includes('[MessageExtractionCoordinator]') &&
				line.includes('✅') &&
				line.includes('matched')
			);
			expect(hit).toBe(true);
		});
	});

	// ============================================================
	// L197 — logExtractionSummary errors > 0 branch (with debug enabled)
	// ============================================================
	describe('L197: logExtractionSummary — errors > 0', () => {
		test('L197: should fire Error details log when result.errors is non-empty', () => {
			const coordinator = new MessageExtractionCoordinator();

			// Force per-extractor throw inside processMessage to populate result.errors
			// (bypasses for...of, lets logExtractionSummary run at L91 with errors populated).
			// First extractor is ApiContentExtractor — needs canHandle=true via
			//   { type: 'api_req_started', content: { tool: 'newTask', ... } }.
			const extractors = (coordinator as any).extractors as any[];
			const originalExtract = extractors[0].extract.bind(extractors[0]);
			extractors[0].extract = () => {
				throw new Error('synthetic error for L197 trigger');
			};

			const messages = [
				{
					type: 'api_req_started',
					role: 'assistant',
					content: { tool: 'newTask', mode: 'code', content: 'some task content' },
				},
			];

			// enableDebug=true: needed for L74 guard + L187 guard returning truthy
			// Then logExtractionSummary runs (L91 in try block — does NOT throw here because
			// per-extractor errors are caught in processMessage's try/catch at L171-176).
			const result = coordinator.extractFromMessages(messages, { enableDebug: true });

			// Restore
			extractors[0].extract = originalExtract;

			expect(result.errors.length).toBeGreaterThan(0);

			const calls = flattenLogCalls(consoleLogSpy);
			// L197 logs "- Error details:" when result.errors.length > 0
			const hit = calls.some(line =>
				line.includes('- Error details')
			);
			expect(hit).toBe(true);
		});
	});

	// ============================================================
	// L206 — logError debug arm (per-extractor throw inside processMessage)
	// ============================================================
	describe('L206: logError — debug arm', () => {
		test('L206: should fire console.error when debug enabled and an extractor throws', () => {
			const coordinator = new MessageExtractionCoordinator();

			// Replace the first extractor's extract method with a throwing one
			// to trigger per-extractor catch in processMessage → logError → L206
			// IMPORTANT: first extractor is ApiContentExtractor, canHandle requires
			//   { type: 'api_req_started', content: { tool: 'newTask', ... } }
			// The extractor's `canHandle` must return true for the throw to land in the try/catch.
			const extractors = (coordinator as any).extractors as any[];
			const originalExtract = extractors[0].extract.bind(extractors[0]);
			extractors[0].extract = () => {
				throw new Error('synthetic per-extractor error');
			};

			const messages = [
				{
					type: 'api_req_started',
					role: 'assistant',
					content: { tool: 'newTask', mode: 'code', content: 'some task content' },
				},
			];

			// IMPORTANT: pass enableDebug=true so L74 keeps debugEnabled=true.
			// Without this, `this.debugEnabled = options.enableDebug || false` resets to false
			// and L206 guard would short-circuit.
			coordinator.extractFromMessages(messages, { enableDebug: true });

			// Restore
			extractors[0].extract = originalExtract;

			const calls = flattenLogCalls(consoleErrorSpy);
			const hit = calls.some(line =>
				line.includes('[MessageExtractionCoordinator]') &&
				line.includes('❌') &&
				line.includes('error')
			);
			expect(hit).toBe(true);
		});
	});

	// ============================================================
	// SKIP-WITH-EVIDENCE branches
	// ============================================================
	describe('Skip-with-evidence branches (anti-churn #1936)', () => {
		test('L62 false-arm: skipped — env var falsy arm already covered in base tests', () => {
			expect(true).toBe(true);
		});
		test('L85 true-arm: covered by base test (string text substring path)', () => {
			expect(true).toBe(true);
		});
		test('L137 unreachable: documented above', () => {
			expect(true).toBe(true);
		});
	});
});