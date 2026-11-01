/**
 * #4352 g10 — text mode states what it searched.
 *
 * The search cache holds task headers (title, first instruction); message content
 * only for tasks loaded in full by the process. A coordinator searched "23948" (a
 * PR number present in session content) and got 0 results with nothing saying the
 * content had not been searched (ai-01 01/11).
 */

import { describe, it, expect } from 'vitest';
import { searchFallbackTool } from '../search-fallback.tool.js';

function run(cache: Map<string, any>, query: string, extra: Record<string, unknown> = {}) {
    return searchFallbackTool({ query, ...extra } as any, cache).then((r: any) => JSON.parse(r.content[0].text));
}

function headerOnly(taskId: string, title: string): any {
    return { taskId, metadata: { title, lastActivity: '2026-11-01T10:00:00Z', workspace: 'd:/roo-extensions' }, truncatedInstruction: '' };
}

function loaded(taskId: string, title: string, content: string): any {
    return { ...headerOnly(taskId, title), sequence: [{ role: 'assistant', content }] };
}

describe('searchFallbackTool — #4352 g10 search scope disclosure', () => {
    it('0 results over header-only tasks says the content was not searched', async () => {
        const cache = new Map([
            ['a', headerOnly('a', 'Coordination pass')],
            ['b', headerOnly('b', 'Fix indexing')],
        ]);

        const out = await run(cache, '23948');

        expect(out.totalFound).toBe(0);
        expect(out.metadata.tasks_examined).toBe(2);
        expect(out.metadata.content_searched_tasks).toBe(0);
        expect(out.metadata.searched_fields).toContain('title');
        expect(out.warnings.join(' ')).toContain('0 results is not evidence of absence');
        expect(out.warnings.join(' ')).toContain('action:"semantic"');
    });

    it('content of a fully loaded task is searched and counted', async () => {
        const cache = new Map([
            ['a', headerOnly('a', 'Coordination pass')],
            ['b', loaded('b', 'Merge review', 'PR 23948 merged by jsboige')],
        ]);

        const out = await run(cache, '23948');

        expect(out.results.map((r: any) => r.taskId)).toEqual(['b']);
        expect(out.metadata.content_searched_tasks).toBe(1);
        expect(out.metadata.tasks_examined).toBe(2);
        expect(out.warnings.join(' ')).toContain('1 of 2');
    });

    it('no warning when every examined task had its content searched', async () => {
        const cache = new Map([['b', loaded('b', 'Merge review', 'PR 23948 merged')]]);

        const out = await run(cache, '23948');

        expect(out.metadata.content_searched_tasks).toBe(1);
        expect(out.warnings).toBeUndefined();
    });

    it('tasks excluded by a filter are not counted as examined', async () => {
        const other = { ...headerOnly('c', 'Other ws'), metadata: { ...headerOnly('c', 'Other ws').metadata, workspace: 'd:/CoursIA' } };
        const cache = new Map<string, any>([
            ['b', loaded('b', 'Merge review', 'PR 23948 merged')],
            ['c', other],
        ]);

        const out = await run(cache, '23948', { workspace: 'roo-extensions' });

        expect(out.metadata.tasks_examined).toBe(1);
        expect(out.metadata.content_searched_tasks).toBe(1);
    });
});
