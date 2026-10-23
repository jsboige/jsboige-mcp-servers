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
 * Content fingerprint of a message — stable across parses for the id-less
 * population (external scripts writing `### [ts] machine|workspace` blocks
 * straight into the file, e.g. embedding/vllm watchdogs), whose synthesized
 * id changes on every parse. Two independent FNV-style hashes (64 effective
 * bits) over timestamp|author|content: two parses of the same block yield the
 * same fingerprint, two distinct messages colliding on it is beyond fleet
 * scale. Used by the condensation stitch delta (#4090) — NOT a persisted id:
 * extractPersistedMessageIds remains the only identity the reconcile keys on.
 */
export function intercomMessageFingerprint(m: {
  timestamp: string;
  author: { machineId: string; workspace: string };
  content: string;
}): string {
  const basis = `${m.timestamp}|${m.author.machineId}|${m.author.workspace}|${m.content}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < basis.length; i++) {
    const c = basis.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 + c, 31) + i) >>> 0;
  }
  return `${h1.toString(36)}-${h2.toString(36)}`;
}

/**
 * Ids PERSISTED in the markdown (`[msg: <id>]` metadata lines, v3 #1363) —
 * the only stable message identity across parses. Pre-v3 messages carry no
 * id line and parseDashboardMarkdown SYNTHESIZES a fresh one at each parse
 * (`new Date()` + random), so they cannot be fingerprinted by ID: any
 * GDrive↔PG parity work (reconcile, backfill) must key on this set and SKIP
 * the rest, or it re-imports id-less messages under a new id forever. For
 * same-process dedup needs use intercomMessageFingerprint (content-stable)
 * instead — never the synthesized id.
 *
 * @param content Normalized content (\n line endings, BOM stripped) — same
 *   contract as parseDashboardMarkdown's callers.
 */
export function extractPersistedMessageIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const match of content.matchAll(/^\[msg: ([^\]]+)\]$/gm)) {
    ids.add(match[1]);
  }
  return ids;
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

  // js-yaml parse un timestamp ISO NON quoté en objet Date (règle YAML 1.1).
  // Le writer sérialise toujours la string (yaml.dump la quote), mais un
  // fichier écrit à la main ou par un outil tiers peut porter la forme nue :
  // un Date qui s'échappe fait crasher le tri de handleList
  // (lastModified.localeCompare) dans le catch « Répertoire dashboards vide »
  // — under-show silencieux, même classe que #1432 review. Le type Dashboard
  // dit string : normaliser.
  const loaded = yaml.load(frontmatterMatch[1]) as Omit<DashboardFrontmatter, 'lastModified'> & {
    lastModified: DashboardFrontmatter['lastModified'] | Date;
  };
  const frontmatter: DashboardFrontmatter = {
    ...loaded,
    lastModified:
      loaded.lastModified instanceof Date ? loaded.lastModified.toISOString() : loaded.lastModified,
  };

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

        // Parse metadata lines ([msg:], [reply-to:], [ack:], [tags:]) then content
        let persistedId: string | undefined;
        let replyTo: string | undefined;
        let ackRaw: string | undefined;
        let persistedTags: string[] | undefined;
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
        // [tags: A, B] (#4003) — persisted tags, read back so a full rewrite
        // (condensation, status update) does not strip them from the file.
        const tagsMatch = remaining.match(/^\[tags: ([^\]]+)\]\n([\s\S]*)/);
        if (tagsMatch) {
          const parsedTags = tagsMatch[1].split(',').map((t: string) => t.trim()).filter((t: string) => t !== '');
          if (parsedTags.length > 0) persistedTags = parsedTags;
          remaining = tagsMatch[2];
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
        if (persistedTags) msg.tags = persistedTags;
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
