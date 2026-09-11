/**
 * Chat-endpoint API key resolution (dispatch ai-01 2026-09-11).
 *
 * The chat client (dashboard condensation) must take its key from the name that
 * MATCHES its endpoint, and must never fall back to EMBEDDING_API_KEY: that key
 * belongs to the embeddings service, and presenting it to the chat endpoint
 * fabricates a 401 on every condensation, masking the real cause ("no chat key
 * configured") behind repeated auth failures that surface only as truncation.
 *
 * Resolution order:
 *  - VLLM_API_KEY_MEDIUM — the fleet's canonical name for the self-hosted vLLM
 *    medium tier that OPENAI_BASE_URL points at. Fleet credential rotations
 *    operate on the VLLM_* names; one name per secret is what makes a rotation
 *    survive (giving the same secret a second name is how this incident started).
 *  - OPENAI_API_KEY — generic OpenAI-compatible fallback, consulted only when
 *    VLLM_API_KEY_MEDIUM is absent.
 *
 * The order is UNCONDITIONAL: OPENAI_BASE_URL is never read here. That matters,
 * because it leaves one residual shape (review myia-po-204 on PR #1147): a seat
 * pointing OPENAI_BASE_URL at a cloud endpoint while still carrying a stale
 * VLLM_API_KEY_MEDIUM would present the stale name — the symmetric form of the
 * defect this file repairs. No measured seat has that shape (po-204, web1 and
 * ai-01 all point at the medium tier), so the branch is deliberately NOT added:
 * resolving per endpoint needs an endpoint-to-key-name mapping, not a second
 * guess at which name is live. Should a cloud-pointing seat appear, that mapping
 * belongs here.
 *
 * Shared by the client (services/openai.ts) and the boot banner (index.ts) so the
 * two cannot drift. Kept dependency-free on purpose: index.ts imports it at boot.
 */
export interface ChatApiKey {
    apiKey: string;
    source: 'VLLM_API_KEY_MEDIUM' | 'OPENAI_API_KEY';
}

export function resolveChatApiKey(): ChatApiKey | null {
    if (process.env.VLLM_API_KEY_MEDIUM) {
        return { apiKey: process.env.VLLM_API_KEY_MEDIUM, source: 'VLLM_API_KEY_MEDIUM' };
    }
    if (process.env.OPENAI_API_KEY) {
        return { apiKey: process.env.OPENAI_API_KEY, source: 'OPENAI_API_KEY' };
    }
    return null;
}
