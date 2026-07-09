/**
 * Coverage tests for get_raw_conversation handler
 *
 * Cible les branches NON couvertes par les 3 fichiers de test existants
 * (get-raw.test.ts, get-raw.tool.test.ts, get-raw.integration.test.ts).
 *
 * **Gap principal (confirmé fresh measure)** : la branche de filtre
 * `includeToolResults=false` (L124-136). Les tests existants n'utilisent
 * `includeToolResults` qu'avec `true` (get-raw.test.ts L274, L300) → le filtre
 * tool_result/tool_use n'est JAMAIS exercé. Pattern C3 (Vein D, dispatch #2800).
 *
 * Branches ciblées :
 *  - L124-127 : filtre message role==='tool' ET type==='tool_result' (return false)
 *  - L129-133 : filtre content-blocks tool_result/tool_use dans un message assistant
 *  - L134 : message assistant conservé (return true) après filtrage des blocks
 *  - L158 note / L157 filteredMessages > 0 (différence post-filter)
 *  - Pagination interactions : includeToolResults=false + range
 *
 * @module tools/conversation/__tests__/get-raw.coverage
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRawConversationTool } from '../get-raw.tool.js';

// Valid UUID for tests
const TASK_UUID = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';

// Mock fs/promises (même pattern que get-raw.test.ts)
const mockAccess = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();

vi.mock('fs', () => ({
  promises: {
    access: (...args: any[]) => mockAccess(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
    stat: (...args: any[]) => mockStat(...args),
  },
}));

// Mock RooStorageDetector
vi.mock('../../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn(),
  },
}));

vi.spyOn(console, 'debug').mockImplementation(() => {});

function setupMocks(apiContent: unknown) {
  mockAccess.mockResolvedValue(undefined);
  // mockResolvedValue renvoie la même valeur pour les 3 lectures (api/ui/metadata)
  mockReadFile.mockResolvedValue(JSON.stringify(apiContent));
  mockStat.mockResolvedValue({
    birthtime: '2024-01-01T00:00:00Z',
    mtime: '2024-01-02T00:00:00Z',
    size: 1024,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
  vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue(['/test/storage']);
});

describe('get_raw_conversation — coverage branche includeToolResults=false', () => {

  // ============================================================
  // Filtre message role==='tool' (L127)
  // ============================================================
  it('includeToolResults=false filtre les messages role=tool', async () => {
    setupMocks([
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'tool output' },           // → filtré (L127)
      { role: 'assistant', content: 'final answer' },
    ]);

    const result = await getRawConversationTool.handler({
      taskId: TASK_UUID,
      includeToolResults: false,
    });

    const data = JSON.parse((result.content[0] as any).text as string);
    const roles = data.api_conversation_history.map((m: any) => m.role);
    expect(roles).not.toContain('tool');
    expect(roles).toEqual(['user', 'assistant']);
  });

  // ============================================================
  // Filtre message type==='tool_result' (L127)
  // ============================================================
  it('includeToolResults=false filtre les messages type=tool_result', async () => {
    setupMocks([
      { role: 'user', content: 'q' },
      { role: 'other', type: 'tool_result', content: 'x' }, // → filtré (L127)
      { role: 'assistant', content: 'a' },
    ]);

    const result = await getRawConversationTool.handler({
      taskId: TASK_UUID,
      includeToolResults: false,
    });

    const data = JSON.parse((result.content[0] as any).text as string);
    expect(data.api_conversation_history).toHaveLength(2);
    expect(data.api_conversation_history.map((m: any) => m.role)).toEqual(['user', 'assistant']);
  });

  // ============================================================
  // Filtre content-blocks tool_result/tool_use dans message assistant (L129-133)
  // + message conservé (return true L134)
  // ============================================================
  it('includeToolResults=false filtre les blocks tool_result/tool_use mais garde le message', async () => {
    setupMocks([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reasoning' },
          { type: 'tool_use', name: 'read_file' },   // block filtré (L131)
          { type: 'tool_result', content: 'output' }, // block filtré (L131)
          { type: 'text', text: 'final' },
        ],
      },
    ]);

    const result = await getRawConversationTool.handler({
      taskId: TASK_UUID,
      includeToolResults: false,
    });

    const data = JSON.parse((result.content[0] as any).text as string);
    // Le message assistant est conservé (return true L134), mais ses blocks tool sont retirés
    expect(data.api_conversation_history).toHaveLength(1);
    const keptMsg = data.api_conversation_history[0];
    const blockTypes = keptMsg.content.map((b: any) => b.type);
    expect(blockTypes).not.toContain('tool_use');
    expect(blockTypes).not.toContain('tool_result');
    expect(blockTypes).toEqual(['text', 'text']);
  });

  // ============================================================
  // Pagination post-filter — returnedMessages + filteredMessages (FIX #2805)
  // ============================================================
  it('returnedMessages + filteredMessages reflètent les comptes post-filter', async () => {
    // #2805 FIX : filteredMessages était toujours 0 (L157 soustrayait
    // `apiResult.data.length` non-filtré de `totalMessages`, qui sont égaux par
    // construction L120). Fixé en capturant le compte post-filter / pre-slice.
    setupMocks([
      { role: 'user', content: 'a' },
      { role: 'tool', content: 't1' }, // filtré
      { role: 'tool', content: 't2' }, // filtré
      { role: 'assistant', content: 'b' },
    ]);

    const result = await getRawConversationTool.handler({
      taskId: TASK_UUID,
      includeToolResults: false,
    });

    const data = JSON.parse((result.content[0] as any).text as string);
    expect(data.pagination.totalMessages).toBe(4);
    expect(data.pagination.returnedMessages).toBe(2); // apiHistory.length post-filter (puis no-slice)
    expect(data.pagination.filteredMessages).toBe(2); // FIX #2805 : 2 messages tool filtrés
    expect(data.pagination.includeToolResults).toBe(false);
  });

  // ============================================================
  // #2805 regression guard — filteredMessages reste 0 quand includeToolResults=true
  // MEME avec slicing de pagination. La fix naïve (totalMessages - apiHistory.length
  // post-slice) aurait violé ce critère en conflatant filter-removal et slice-removal.
  // La fix retenue capture le compte pre-slice → isolé du slice.
  // ============================================================
  it('includeToolResults=true + range : filteredMessages reste 0 (pas de conflit filter/slice)', async () => {
    setupMocks([
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
      { role: 'user', content: 'm3' },
      { role: 'assistant', content: 'm4' },
    ]);

    const result = await getRawConversationTool.handler({
      taskId: TASK_UUID,
      includeToolResults: true, // aucun filtrage tool
      startMessage: 1,
      endMessage: 2, // slice garde 2/4 → mais AUCUN filtrage
    });

    const data = JSON.parse((result.content[0] as any).text as string);
    expect(data.api_conversation_history).toHaveLength(2); // slicé
    expect(data.pagination.totalMessages).toBe(4);
    expect(data.pagination.returnedMessages).toBe(2); // post-slice
    expect(data.pagination.filteredMessages).toBe(0); // FIX #2805 : 0 filter, slice n'affecte pas ce compte
    expect(data.pagination.includeToolResults).toBe(true);
  });

  // ============================================================
  // includeToolResults=false + pagination (interaction L139-141)
  // ============================================================
  it('includeToolResults=false + range applique la pagination post-filter', async () => {
    setupMocks([
      { role: 'user', content: 'm1' },
      { role: 'tool', content: 'tool-m2' },  // filtré
      { role: 'assistant', content: 'm3' },
      { role: 'tool', content: 'tool-m4' },  // filtré
      { role: 'user', content: 'm5' },
    ]);

    const result = await getRawConversationTool.handler({
      taskId: TASK_UUID,
      includeToolResults: false,
      startMessage: 1,
      endMessage: 2, // 2 premiers messages POST-filter = [m1, m3]
    });

    const data = JSON.parse((result.content[0] as any).text as string);
    expect(data.api_conversation_history).toHaveLength(2);
    expect(data.api_conversation_history.map((m: any) => m.content)).toEqual(['m1', 'm3']);
    expect(data.pagination.returnedMessages).toBe(2);
  });

  // ============================================================
  // Default includeToolResults=true ne filtre rien (garde-fou non-régression)
  // ============================================================
  it('includeToolResults=true (défaut) conserve tous les messages y compris tool', async () => {
    setupMocks([
      { role: 'user', content: 'a' },
      { role: 'tool', content: 't' },
    ]);

    const result = await getRawConversationTool.handler({
      taskId: TASK_UUID,
      // includeToolResults omis → défaut true
    });

    const data = JSON.parse((result.content[0] as any).text as string);
    expect(data.api_conversation_history).toHaveLength(2);
    expect(data.pagination.includeToolResults).toBe(true);
    expect(data.pagination.filteredMessages).toBe(0);
  });
});
