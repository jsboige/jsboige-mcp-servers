import OpenAI from 'openai';
import { StateManagerError } from '../types/errors.js';

let openai: OpenAI | null = null;

/**
 * Returns the embedding model name from env or default.
 * Supports custom models like Qwen3-4B via EMBEDDING_MODEL env var.
 */
export function getEmbeddingModel(): string {
  return process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
}

/**
 * Returns the expected embedding dimensions from env or default.
 * Must match the model output (e.g., 1536 for text-embedding-3-small, 2560 for Qwen3-4B).
 */
export function getEmbeddingDimensions(): number {
  const dims = parseInt(process.env.EMBEDDING_DIMENSIONS || '1536', 10);
  return Number.isFinite(dims) && dims > 0 ? dims : 1536;
}

/**
 * Get OpenAI-compatible client for embeddings.
 * Uses EMBEDDING_API_KEY preferentially (for self-hosted vLLM like Qwen3-4B),
 * falls back to OPENAI_API_KEY for backward compatibility.
 * Both task-level semantic search and codebase_search use the same embedding infra.
 */
function getOpenAIClient(): OpenAI {
  if (!openai) {
    const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new StateManagerError(
        'No embedding API key configured. Set EMBEDDING_API_KEY (preferred) or OPENAI_API_KEY.',
        'EMBEDDING_API_KEY_MISSING',
        'OpenAIClient',
        { envVar: 'EMBEDDING_API_KEY' }
      );
    }
    openai = new OpenAI({
      apiKey,
      baseURL: process.env.EMBEDDING_API_BASE_URL || undefined,
    });
  }
  return openai;
}

export default getOpenAIClient;