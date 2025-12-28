import { searchTasksByContentTool } from '../../../../src/tools/search/search-semantic.tool.js';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Mocks
const mockQdrantClient = {
  search: vi.fn(),
  getCollection: vi.fn(),
};

const mockOpenAIClient = {
  embeddings: {
    create: vi.fn()
  }
};

vi.mock('../../../../src/services/qdrant.js', () => ({
  getQdrantClient: vi.fn(() => mockQdrantClient)
}));

vi.mock('../../../../src/services/openai.js', () => ({
  default: vi.fn(() => mockOpenAIClient)
}));

// Mock TaskIndexer pour getHostIdentifier
vi.mock('../../../../src/services/task-indexer.js', () => ({
  TaskIndexer: class {},
  getHostIdentifier: vi.fn(() => 'test-host-os')
}));

describe('🔍 search_tasks_by_content', () => {
  let conversationCache: Map<string, any>;
  let ensureCacheFreshCallback: any;
  let fallbackHandler: any;
  let diagnoseHandler: any;

  beforeEach(() => {
    conversationCache = new Map();
    ensureCacheFreshCallback = vi.fn().mockResolvedValue(true);
    fallbackHandler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Fallback result' }]
    });
    diagnoseHandler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Diagnostic result' }]
    });

    // Reset mocks
    vi.clearAllMocks();
    
    // Setup default mock responses
    mockOpenAIClient.embeddings.create.mockResolvedValue({
      data: [{ embedding: Array(1536).fill(0.1) }]
    });

    mockQdrantClient.search.mockResolvedValue([
      {
        id: 'chunk-1',
        score: 0.95,
        payload: {
          task_id: 'task-1',
          content: 'This is a test content match',
          chunk_type: 'message_exchange',
          workspace: 'test-workspace',
          task_title: 'Test Task',
          host_os: 'test-host-os'
        }
      }
    ]);
  });

  it('should perform semantic search successfully', async () => {
    const args = {
      search_query: 'test query',
      max_results: 5
    };

    const result = await searchTasksByContentTool.handler(
      args,
      conversationCache,
      ensureCacheFreshCallback,
      fallbackHandler
    );

    expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: 'test query'
    });

    expect(mockQdrantClient.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        vector: expect.any(Array),
        limit: 5,
        with_payload: true
      })
    );

    expect(result.isError).toBe(false);
    const content = JSON.parse(result.content[0].text as string);
    expect(content.results).toHaveLength(1);
    expect(content.results[0].taskId).toBe('task-1');
    expect(content.current_machine.host_id).toBe('test-host-os');
  });

  it('should apply filters correctly', async () => {
    const args = {
      search_query: 'test query',
      conversation_id: 'task-123',
      workspace: 'specific-workspace'
    };

    await searchTasksByContentTool.handler(
      args,
      conversationCache,
      ensureCacheFreshCallback,
      fallbackHandler
    );

    expect(mockQdrantClient.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        filter: {
          must: [
            { key: 'task_id', match: { value: 'task-123' } },
            { key: 'workspace', match: { value: 'specific-workspace' } }
          ]
        }
      })
    );
  });

  it('should handle diagnostic mode', async () => {
    const args = {
      search_query: 'ignored',
      diagnose_index: true
    };

    const result = await searchTasksByContentTool.handler(
      args,
      conversationCache,
      ensureCacheFreshCallback,
      fallbackHandler,
      diagnoseHandler
    );

    expect(diagnoseHandler).toHaveBeenCalled();
    expect(result.content[0].text).toBe('Diagnostic result');
  });

  it('should fallback to text search on semantic error', async () => {
    mockOpenAIClient.embeddings.create.mockRejectedValue(new Error('OpenAI Error'));

    const args = {
      search_query: 'test query'
    };

    const result = await searchTasksByContentTool.handler(
      args,
      conversationCache,
      ensureCacheFreshCallback,
      fallbackHandler
    );

    expect(fallbackHandler).toHaveBeenCalled();
    expect(result.content[0].text).toBe('Fallback result');
  });

  it('should handle empty results gracefully', async () => {
    mockQdrantClient.search.mockResolvedValue([]);

    const args = {
      search_query: 'no match'
    };

    const result = await searchTasksByContentTool.handler(
      args,
      conversationCache,
      ensureCacheFreshCallback,
      fallbackHandler
    );

    const content = JSON.parse(result.content[0].text as string);
    expect(content.results).toHaveLength(0);
    expect(content.current_machine.results_count).toBe(0);
  });
});