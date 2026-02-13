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

function getOpenAIClient(): OpenAI {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new StateManagerError(
        'OpenAI API key is not configured. Please set the OPENAI_API_KEY environment variable.',
        'OPENAI_API_KEY_MISSING',
        'OpenAIClient',
        { envVar: 'OPENAI_API_KEY' }
      );
    }
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.EMBEDDING_API_BASE_URL || undefined,
    });
  }
  return openai;
}

export default getOpenAIClient;