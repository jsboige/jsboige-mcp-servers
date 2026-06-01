import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { describeLLMError, condenseEndpointHost } from '../../../../src/tools/roosync/dashboard.js';

/**
 * Regression guard for the user mandate (2026-06-01):
 *   "Le condenser doit exploser avec des erreurs explicites le cas échéant,
 *    pas nous mettre des timeout dont on ne sait ce qu'il y a derrière."
 *
 * A condensation failure must surface WHAT failed, against WHICH endpoint/model,
 * and after how long — never an opaque, contextless "timeout".
 */
describe('condense explicit-error surfacing (describeLLMError)', () => {
  const ORIG = process.env.OPENAI_BASE_URL;

  beforeEach(() => {
    process.env.OPENAI_BASE_URL = 'https://api.medium.text-generation-webui.myia.io/v1';
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = ORIG;
  });

  it('condenseEndpointHost returns the host only (no secret/path)', () => {
    const host = condenseEndpointHost();
    expect(host).toBe('api.medium.text-generation-webui.myia.io');
    expect(host).not.toContain('/v1');
  });

  it('condenseEndpointHost is robust when OPENAI_BASE_URL is unset or malformed', () => {
    delete process.env.OPENAI_BASE_URL;
    expect(condenseEndpointHost()).toBe('(OPENAI_BASE_URL unset)');
    process.env.OPENAI_BASE_URL = 'not-a-url';
    expect(condenseEndpointHost()).toBe('not-a-url');
  });

  it('timeout case: surfaces duration, limit, endpoint host, model and a hang explanation', () => {
    const msg = describeLLMError(new Error('aborted'), {
      isTimeout: true,
      timeoutMs: 720_000,
      elapsedMs: 723_456,
      model: 'qwen3.6-35b-a3b',
    });
    expect(msg).toContain('TIMEOUT after 723s');
    expect(msg).toContain('limit 720s');
    expect(msg).toContain('socket held open');
    expect(msg).toContain('api.medium.text-generation-webui.myia.io');
    expect(msg).toContain('model=qwen3.6-35b-a3b');
    // vLLM endpoint → provider label vLLM
    expect(msg).toContain('[vLLM ');
  });

  it('HTTP-error case: surfaces the status code and the provider body', () => {
    const apiErr = { status: 400, error: { message: 'enable_thinking is not a valid parameter' } };
    const msg = describeLLMError(apiErr, {
      isTimeout: false,
      timeoutMs: 720_000,
      elapsedMs: 1_200,
      model: 'glm-5.1',
    });
    expect(msg).toContain('HTTP 400');
    expect(msg).toContain('enable_thinking is not a valid parameter');
    expect(msg).toContain('model=glm-5.1');
  });

  it('remote (non-vLLM) endpoint is labelled "remote"', () => {
    process.env.OPENAI_BASE_URL = 'https://api.z.ai/v1';
    const msg = describeLLMError(new Error('boom'), {
      isTimeout: true,
      timeoutMs: 720_000,
      elapsedMs: 720_000,
      model: 'glm-5.1',
    });
    expect(msg).toContain('[remote ');
    expect(msg).toContain('api.z.ai');
  });

  it('error with code but no status still produces an explicit, bounded string', () => {
    const netErr = { code: 'ECONNRESET', message: 'socket hang up' };
    const msg = describeLLMError(netErr, {
      isTimeout: false,
      timeoutMs: 720_000,
      elapsedMs: 5_000,
      model: 'glm-5.1',
    });
    expect(msg).toContain('code=ECONNRESET');
    expect(msg).toContain('socket hang up');
    expect(msg.length).toBeLessThanOrEqual(240);
  });
});
