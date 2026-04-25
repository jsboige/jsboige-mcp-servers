/**
 * Integration test — Live LLM condensation repro (IIS 502 investigation 2026-04-20)
 *
 * WHY this test exists
 * --------------------
 * CoursIA dashboard condensation failed repeatedly 2026-04-20 19:23-22:35Z with
 * `condensed: false`, 375s elapsed, HTTP 502 from the reverse proxy wrapping
 * vLLM. The condensation code retries 3× per LLM call, and runs 2 calls in
 * parallel (summary + status), so a single failed condense burns ~6 upstream
 * calls. The new diagnostic (PR #159) revealed the actual failure mode is
 * upstream 502s, not LLM null-content as originally suspected.
 *
 * This test reproduces the exact prompt+wire-format that the production
 * code sends, against the real endpoint, with full instrumentation
 * (request size, response status, response body, timing). Result goes to
 * `__tests__/artifacts/llm-repro-<timestamp>.{json,html}` for sharing
 * with the IIS admin.
 *
 * SKIPPED by default — opt-in via:
 *   set LLM_LIVE_INTEGRATION=1
 *   npx vitest run src/tools/roosync/__tests__/dashboard-llm-live.integration.test.ts
 *
 * Also excluded from CI via vitest.config.ci.ts.
 *
 * @bugfix #1578 — 502 repro from IIS reverse proxy in front of vLLM
 */
import { describe, test, expect, beforeAll, vi } from 'vitest';
import { readFile, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Integration test — hit the real endpoint. The global vitest setup mocks
// 'openai' to avoid accidental network calls; unmock it for this file only.
vi.unmock('openai');

const OpenAIMod = await import('openai');
const OpenAI = (OpenAIMod as any).default ?? OpenAIMod;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LIVE = process.env.LLM_LIVE_INTEGRATION === '1';

interface IntercomMessage {
  id: string;
  timestamp: string;
  author: { machineId: string; workspace: string };
  content: string;
}

interface LLMCallObservation {
  label: string;
  attempt: number;
  requestBytes: number;
  systemPromptBytes: number;
  userPromptBytes: number;
  elapsedMs: number;
  httpStatus: number | null;
  finishReason: string | null;
  contentLength: number;
  sizeBytes: number;
  responseHeaders: Record<string, string> | null;
  errorKind: 'ok' | 'null-content' | 'http-error' | 'timeout' | 'network' | 'sdk-error';
  errorMessage: string | null;
  errorBodyExcerpt: string | null;
}

/**
 * Inline copy of the intercom parser from dashboard.ts:readDashboardFile.
 * Duplicated rather than exported to keep this test self-contained.
 */
function parseDashboard(content: string): {
  statusMarkdown: string;
  messages: IntercomMessage[];
} {
  const normalized = content.replace(/\r\n/g, '\n');
  const frontmatterMatch = normalized.match(/^---\n([\s\S]+?)\n---/);
  if (!frontmatterMatch) {
    throw new Error('Dashboard frontmatter missing');
  }
  const markdownContent = normalized.slice(frontmatterMatch[0].length);
  const statusMatch = markdownContent.match(/## Status\n([\s\S]+?)(?=\n## Intercom|\n*$)/);
  const intercomMatch = markdownContent.match(/## Intercom[\s\S]*?\n\n([\s\S]+)$/);
  const statusMarkdown = statusMatch ? statusMatch[1].trim() : '';
  const intercomMarkdown = intercomMatch ? intercomMatch[1].trim() : '';

  const messages: IntercomMessage[] = [];
  if (intercomMarkdown && !intercomMarkdown.includes('*Aucun message.*')) {
    const blocks = intercomMarkdown.split(/(?=^### \[)/m).filter(b => b.trim());
    for (const rawBlock of blocks) {
      const block = rawBlock.replace(/\n---\s*$/, '').trim();
      const headerMatch = block.match(
        /### \[([^\]]+)\]\s+([^|]+)\|([^|\s]+)(\s+\[[^\]]+\])?\n(?:\[msg: ([^\]]+)\]\n)?\n([\s\S]+)/
      );
      if (headerMatch) {
        const [, timestamp, machineId, workspace, , persistedId, body] = headerMatch;
        const unescaped = body.trim().replace(/^\\#\\#\\# \[/gm, '### [');
        messages.push({
          id: persistedId || `ic-${timestamp.replace(/[^\w]/g, '')}-auto`,
          timestamp,
          author: { machineId: machineId.trim(), workspace: workspace.trim() },
          content: unescaped
        });
      }
    }
  }
  return { statusMarkdown, messages };
}

function buildSummaryPrompt(messages: IntercomMessage[]): { system: string; user: string } {
  const messagesContent = messages
    .map(m => `[${m.timestamp}] ${m.author.machineId}|${m.author.workspace}\n${m.content}`)
    .join('\n\n---\n\n');
  const system = `Tu es un expert en synthèse de communications inter-agents.

CONTEXTE : Ces messages viennent d'être RETIRÉS d'un dashboard de coordination et archivés.
Ce résumé sera le SEUL enregistrement visible de ces messages dans le dashboard.

EXIGENCES :
- ZÉRO perte d'information actionnable (décisions, résultats, blocages résolus)
- Regrouper par THÈMES, pas par message individuel
- Préserver les métriques chiffrées exactes (scores, taux, nombres)
- Préserver les dates des événements importants
- Maximum 20 lignes. Pas d'emojis. Pas de prose, que du factuel.
- Le résumé DOIT faire moins de 5 Ko. Être CONCIS mais COMPLET.
- Ne JAMAIS inventer d'informations absentes des messages

FORMAT :
## Résumé des ${messages.length} messages archivés

### Thèmes principaux
- [thème] : synthèse factuelle

### Actions et résultats
- [DONE/BLOCKED/EN COURS] description avec dates

### Décisions et métriques
- Décisions prises, valeurs chiffrées, résultats mesurés`;
  const user = `${messages.length} messages retirés du dashboard à synthétiser :\n\n${messagesContent}\n\nRésume ces messages archivés. Ce résumé sera la seule trace visible dans le dashboard.`;
  return { system, user };
}

function buildStatusPrompt(
  previousStatus: string,
  allMessages: IntercomMessage[],
  archivedCount: number
): { system: string; user: string } {
  const messagesContent = allMessages
    .map((m, i) => {
      const annotation = i < archivedCount ? '[SERA ARCHIVÉ]' : '[CONSERVÉ]';
      return `${annotation} [${m.timestamp}] ${m.author.machineId}|${m.author.workspace}\n${m.content}`;
    })
    .join('\n\n---\n\n');
  const lastDate =
    allMessages.length > 0 ? allMessages[allMessages.length - 1].timestamp : new Date().toISOString();
  const system = `Tu es un expert en synthèse de dashboards de coordination multi-agents.

CONTEXTE : Le dashboard contient un STATUT (mémoire de travail du projet) et des MESSAGES INTERCOM.
Les messages les plus anciens vont être archivés. Ta mission : mettre à jour le statut en y intégrant les infos importantes des messages qui vont disparaître.

STRUCTURE :
## [Workspace] — État au ${lastDate}

### Résumé
[2-3 phrases]

### État des systèmes
[par entité: état (source: date)]

### Livrables récents
### En cours
### Blocages / Attention
### Décisions et métriques`;
  const user = `**Statut précédent :**
${previousStatus}

**${allMessages.length} messages intercom (dont ${archivedCount} seront archivés, ${allMessages.length - archivedCount} conservés) :**
${messagesContent}

Mets à jour le statut. Date de référence : ${lastDate}.`;
  return { system, user };
}

/**
 * Single LLM call with full instrumentation — one attempt, no retry.
 * The retry loop is exercised by calling this 3× from the test.
 */
async function callLLMOnce(
  label: string,
  attempt: number,
  system: string,
  user: string
): Promise<LLMCallObservation> {
  const requestBody = JSON.stringify({
    model: process.env.OPENAI_CHAT_MODEL_ID || 'qwen3.6-35b-a3b',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    max_tokens: 30000,
    temperature: 0.3
  });
  const requestBytes = Buffer.byteLength(requestBody, 'utf8');
  const systemPromptBytes = Buffer.byteLength(system, 'utf8');
  const userPromptBytes = Buffer.byteLength(user, 'utf8');

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_BASE_URL!,
    maxRetries: 0
  });
  const start = Date.now();
  try {
    const resp = await openai.chat.completions.create(
      {
        model: process.env.OPENAI_CHAT_MODEL_ID || 'qwen3.6-35b-a3b',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        max_tokens: 30000,
        temperature: 0.3
      },
      { timeout: 1800000 }
    );
    const elapsedMs = Date.now() - start;
    const choice = resp.choices[0];
    const content = choice?.message?.content ?? null;
    return {
      label,
      attempt,
      requestBytes,
      systemPromptBytes,
      userPromptBytes,
      elapsedMs,
      httpStatus: 200,
      finishReason: choice?.finish_reason || null,
      contentLength: content?.length ?? 0,
      sizeBytes: content ? Buffer.byteLength(content, 'utf8') : 0,
      responseHeaders: null,
      errorKind: content ? 'ok' : 'null-content',
      errorMessage: null,
      errorBodyExcerpt: null
    };
  } catch (err: any) {
    const elapsedMs = Date.now() - start;
    // OpenAI SDK surfaces APIError with .status, .headers, .message
    const httpStatus = err?.status ?? null;
    const headers = err?.headers
      ? Object.fromEntries(
          (err.headers instanceof Map ? [...err.headers.entries()] : Object.entries(err.headers)) as [
            string,
            string
          ][]
        )
      : null;
    const bodyExcerpt =
      typeof err?.message === 'string' ? err.message.substring(0, 1000) : String(err).substring(0, 1000);
    let errorKind: LLMCallObservation['errorKind'] = 'sdk-error';
    if (err?.name === 'AbortError') errorKind = 'timeout';
    else if (httpStatus != null) errorKind = 'http-error';
    else if (err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET') errorKind = 'network';
    return {
      label,
      attempt,
      requestBytes,
      systemPromptBytes,
      userPromptBytes,
      elapsedMs,
      httpStatus,
      finishReason: null,
      contentLength: 0,
      sizeBytes: 0,
      responseHeaders: headers,
      errorKind,
      errorMessage: err?.message ?? String(err),
      errorBodyExcerpt: bodyExcerpt
    };
  }
}

const d = LIVE ? describe : describe.skip;

d('Live LLM condensation repro — CoursIA (IIS 502 investigation)', () => {
  let dashboardContent: string;
  let statusMarkdown: string;
  let messages: IntercomMessage[];
  let artifactsDir: string;

  beforeAll(async () => {
    const sharedPath = process.env.ROOSYNC_SHARED_PATH;
    if (!sharedPath) {
      throw new Error('ROOSYNC_SHARED_PATH not set — required for this test');
    }
    const workspace = process.env.LLM_REPRO_WORKSPACE || 'CoursIA';
    const dashboardFile = join(sharedPath, 'dashboards', `workspace-${workspace}.md`);
    dashboardContent = await readFile(dashboardFile, 'utf8');
    const parsed = parseDashboard(dashboardContent);
    statusMarkdown = parsed.statusMarkdown;
    messages = parsed.messages;

    artifactsDir = join(__dirname, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
  });

  test('full retry loop (3 attempts × 2 parallel calls = 6 upstream calls, captures every 502)', async () => {
    expect(messages.length).toBeGreaterThan(10); // need enough to archive
    const keepCount = 10;
    const toArchive = messages.slice(0, messages.length - keepCount);
    const { system: summarySys, user: summaryUser } = buildSummaryPrompt(toArchive);
    const { system: statusSys, user: statusUser } = buildStatusPrompt(
      statusMarkdown,
      messages,
      toArchive.length
    );

    const observations: LLMCallObservation[] = [];

    // Exercise the full retry loop deterministically — 3 attempts per call, 2 calls in parallel
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [summaryObs, statusObs] = await Promise.all([
        callLLMOnce('summary', attempt, summarySys, summaryUser),
        callLLMOnce('status', attempt, statusSys, statusUser)
      ]);
      observations.push(summaryObs, statusObs);

      // Early exit if BOTH succeeded (matches production's early-return-on-content)
      if (summaryObs.errorKind === 'ok' && statusObs.errorKind === 'ok') {
        break;
      }
      // Backoff matches production: 2s, 4s
      if (attempt < 3) {
        const backoff = 2000 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoff));
      }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const artifact = {
      timestamp,
      workspace: process.env.LLM_REPRO_WORKSPACE || 'CoursIA',
      endpoint: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_CHAT_MODEL_ID || 'qwen3.6-35b-a3b',
      dashboardBytes: Buffer.byteLength(dashboardContent, 'utf8'),
      messageCount: messages.length,
      archivedCount: toArchive.length,
      summary: {
        totalAttempts: observations.filter(o => o.label === 'summary').length,
        finalOutcome: observations.filter(o => o.label === 'summary').slice(-1)[0]?.errorKind,
        statuses: observations.filter(o => o.label === 'summary').map(o => o.httpStatus),
        errors: observations.filter(o => o.label === 'summary' && o.errorKind !== 'ok').map(o => ({
          attempt: o.attempt,
          status: o.httpStatus,
          kind: o.errorKind,
          elapsedMs: o.elapsedMs,
          msgExcerpt: o.errorMessage?.substring(0, 200)
        }))
      },
      status: {
        totalAttempts: observations.filter(o => o.label === 'status').length,
        finalOutcome: observations.filter(o => o.label === 'status').slice(-1)[0]?.errorKind,
        statuses: observations.filter(o => o.label === 'status').map(o => o.httpStatus),
        errors: observations.filter(o => o.label === 'status' && o.errorKind !== 'ok').map(o => ({
          attempt: o.attempt,
          status: o.httpStatus,
          kind: o.errorKind,
          elapsedMs: o.elapsedMs,
          msgExcerpt: o.errorMessage?.substring(0, 200)
        }))
      },
      observations
    };

    const jsonPath = join(artifactsDir, `llm-repro-${timestamp}.json`);
    await writeFile(jsonPath, JSON.stringify(artifact, null, 2));

    const bodyHtmlFragments: string[] = [];
    for (const o of observations) {
      if (o.errorBodyExcerpt && (o.errorKind === 'http-error' || o.errorKind === 'sdk-error')) {
        bodyHtmlFragments.push(
          `<h3>${o.label} attempt ${o.attempt} — HTTP ${o.httpStatus} — ${o.elapsedMs}ms</h3><pre>${escapeHtml(o.errorBodyExcerpt)}</pre>`
        );
      }
    }
    if (bodyHtmlFragments.length > 0) {
      const htmlPath = join(artifactsDir, `llm-repro-${timestamp}-errors.html`);
      await writeFile(
        htmlPath,
        `<!doctype html><meta charset="utf-8"><title>LLM repro ${timestamp}</title>${bodyHtmlFragments.join('\n')}`
      );
      console.error(`[llm-repro] ${bodyHtmlFragments.length} error bodies saved to ${htmlPath}`);
    }
    console.error(`[llm-repro] artifact JSON → ${jsonPath}`);
    console.error(
      `[llm-repro] summary: ${artifact.summary.finalOutcome} (statuses: ${artifact.summary.statuses.join(', ')}) | status: ${artifact.status.finalOutcome} (statuses: ${artifact.status.statuses.join(', ')})`
    );

    // Pure observational test — does not fail on 502, just captures.
    expect(observations.length).toBeGreaterThanOrEqual(2);
  }, 30 * 60 * 1000); // 30 min hard cap
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
