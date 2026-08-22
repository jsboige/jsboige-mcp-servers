/**
 * Dashboard Markdown serialization — parse only, zero heavy deps.
 *
 * @module tools/roosync/dashboard-markdown
 * @issue #3151 Phase C
 *
 * Extracted from dashboard.ts so the backfill script
 * (scripts/backfill-roosync-dashboards.mjs) can parse GDrive dashboard files
 * WITHOUT importing the full tool module (which pulls the LLM client,
 * mention helpers and heartbeat wiring — none of which a CLI backfill should
 * execute). dashboard.ts remains the only caller at runtime; this module is
 * the single home of the markdown format.
 *
 * Dependency surface: js-yaml + the zod-free type imports. Keep it that way.
 */

import * as yaml from 'js-yaml';
import type { Dashboard, DashboardFrontmatter, IntercomMessage } from './dashboard-schemas.js';

/**
 * Génère un ID unique pour un message intercom.
 * Format v3 (#1363): ${machineId}:${workspace}:ic-${ts}-${rand}
 * Aligné avec RooSync inbox pour permettre le référencement cross-message.
 */
export function generateMessageId(machineId: string, workspace: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '').substring(0, 16);
  const rand = Math.random().toString(36).substring(2, 6);
  return `${machineId}:${workspace}:ic-${ts}-${rand}`;
}

/**
 * Parse un fichier dashboard Markdown (contenu + clé) en Dashboard.
 *
 * Format : frontmatter YAML, section `## Status`, section `## Intercom` avec
 * messages `### [timestamp] machine|workspace` + lignes metadata
 * `[msg:]/[reply-to:]/[ack:]` (v3 #1363, #1956). Le format tags legacy
 * `### [ts] machine|workspace [TAGS]` est toléré et ignoré (tags retirés
 * 2026-04).
 *
 * @throws quand le frontmatter est absent (fichier corrompu).
 */
export function parseDashboardMarkdown(content: string, key: string): Dashboard {
  // Parser le frontmatter YAML (entre --- et ---)
  const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---/);
  if (!frontmatterMatch) {
    throw new Error(`Format dashboard invalide: frontmatter manquant (${key})`);
  }

  const frontmatter: DashboardFrontmatter = yaml.load(frontmatterMatch[1]) as DashboardFrontmatter;

  // Extraire le contenu markdown après le frontmatter
  const markdownContent = content.slice(frontmatterMatch[0].length);

  // Séparer les sections Status et Intercom
  const statusMatch = markdownContent.match(/## Status\n([\s\S]+?)(?=\n## Intercom|\n*$)/);
  const intercomMatch = markdownContent.match(/## Intercom[\s\S]*?\n\n([\s\S]+)$/);

  const statusMarkdown = statusMatch ? statusMatch[1].trim() : '';
  const intercomMarkdown = intercomMatch ? intercomMatch[1].trim() : '';

  // Parser les messages intercom (format: ### [timestamp] machine|workspace\n\ncontent)
  // Bug fix: split on message headers instead of `---` which can appear in message content
  const messages: IntercomMessage[] = [];
  if (intercomMarkdown && !intercomMarkdown.includes('*Aucun message.*')) {
    // Split on message headers (### [) while keeping the header in each block
    const messageBlocks = intercomMarkdown.split(/(?=^### \[)/m).filter(b => b.trim());
    for (const rawBlock of messageBlocks) {
      // Strip trailing --- separators (leftover from write format)
      const block = rawBlock.replace(/\n---\s*$/, '').trim();
      // Note: machineId et workspace peuvent contenir des tirets (ex: test-machine, roo-extensions)
      // On utilise [^|\s]+ au lieu de \w+ pour permettre les tirets
      // Le segment optionnel `\s+\[([^\]]+)\]` est l'ancien format tags — toujours toléré, jamais réutilisé.
      // v3 (#1363): ligne `[msg: <id>]` optionnelle immédiatement après le header, avant le contenu.
      // #1956: optional `[reply-to: <id>]` and `[ack: <data>]` metadata lines after [msg:]
      const headerMatch = block.match(/### \[([^\]]+)\]\s+([^|]+)\|([^|\s]+)( \[[^\]]+\])?\n([\s\S]+)/);
      if (headerMatch) {
        const [, timestamp, machineId, workspace, , afterHeader] = headerMatch;
        const mid = machineId.trim();
        const ws = workspace.trim();

        // Parse metadata lines ([msg:], [reply-to:], [ack:]) then content
        let persistedId: string | undefined;
        let replyTo: string | undefined;
        let ackRaw: string | undefined;
        let remaining = afterHeader;

        // [msg: <id>]
        const msgMatch = remaining.match(/^\[msg: ([^\]]+)\]\n([\s\S]*)/);
        if (msgMatch) {
          persistedId = msgMatch[1];
          remaining = msgMatch[2];
        }
        // [reply-to: <id>]
        const replyMatch = remaining.match(/^\[reply-to: ([^\]]+)\]\n([\s\S]*)/);
        if (replyMatch) {
          replyTo = replyMatch[1];
          remaining = replyMatch[2];
        }
        // [ack: machine1:ts1, machine2:ts2]
        const ackMatch = remaining.match(/^\[ack: ([^\]]+)\]\n([\s\S]*)/);
        if (ackMatch) {
          ackRaw = ackMatch[1];
          remaining = ackMatch[2];
        }

        // Content starts after optional blank line
        const msgContent = remaining.replace(/^\n/, '');
        const unescapedContent = msgContent.trim().replace(/^\\#\\#\\# \[/gm, '### [');

        // Parse acknowledged_at from raw string
        let acknowledged_at: Record<string, string> | undefined;
        if (ackRaw) {
          const entries = ackRaw.split(', ').map((entry: string) => {
            const colonIdx = entry.indexOf(':');
            return [entry.slice(0, colonIdx), entry.slice(colonIdx + 1)];
          });
          acknowledged_at = Object.fromEntries(entries);
        }

        const msg: IntercomMessage = {
          id: persistedId || generateMessageId(mid, ws),
          timestamp,
          author: { machineId: mid, workspace: ws },
          content: unescapedContent
        };
        if (replyTo) msg.reply_to = replyTo;
        if (acknowledged_at && Object.keys(acknowledged_at).length > 0) {
          msg.acknowledged_at = acknowledged_at;
        }
        messages.push(msg);
      }
    }
  }

  return {
    type: frontmatter.type,
    key,
    lastModified: frontmatter.lastModified,
    lastModifiedBy: frontmatter.lastModifiedBy,
    status: { markdown: statusMarkdown },
    intercom: {
      messages,
      totalMessages: frontmatter.totalMessages || messages.length,
      lastCondensedAt: frontmatter.lastCondensedAt
    }
  };
}
