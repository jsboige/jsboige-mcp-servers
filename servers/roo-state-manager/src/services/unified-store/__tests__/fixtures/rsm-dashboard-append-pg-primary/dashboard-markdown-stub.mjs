/**
 * #4915 test double for `build/tools/roosync/dashboard-markdown.js` — the
 * served markdown parser, imported by the CLI only on the gated paths
 * (review ms#1919: the file half is read directly, because `readDashboardFile`
 * answers from PG as soon as the key has a readable row there).
 *
 * A twin of the ONE contract those paths rely on, no more: flat frontmatter
 * (the harness writes `type` / `lastModified` / `totalMessages` /
 * `mirrorExportAt` only — the real module parses YAML with js-yaml, which the
 * temp root does not carry), `## Intercom` blocks `### [ts] machine|workspace`
 * + `[msg: id]` + content, and the same two normalisations as
 * `readDashboardFromGdrive` + `parseDashboardMarkdown` (CRLF stripped by the
 * caller, block trimmed, a `\### [`/`\## ` escape unescaped).
 *
 * An id-less block gets a FRESH id at every parse, exactly like the real
 * module (`generateMessageId`): that is what makes an id-only comparison
 * between two parses wrong, and `fileOnlyMessages` compares content for it.
 * A missing frontmatter THROWS, as the real one does — a corrupt file is not
 * an empty dashboard.
 */
let idless = 0;

const parseFrontmatter = (raw) => {
  const out = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
};

export function parseDashboardMarkdown(content, key) {
  const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---/);
  if (!frontmatterMatch) {
    throw new Error(`Format dashboard invalide: frontmatter manquant (${key})`);
  }
  const frontmatter = parseFrontmatter(frontmatterMatch[1]);

  const markdownContent = content.slice(frontmatterMatch[0].length);
  const statusMatch = markdownContent.match(/## Status\n([\s\S]+?)(?=\n## Intercom|\n*$)/);
  const intercomMatch = markdownContent.match(/## Intercom[\s\S]*?\n\n([\s\S]+)$/);
  const statusMarkdown = statusMatch ? statusMatch[1].trim() : '';
  const intercomMarkdown = intercomMatch ? intercomMatch[1].trim() : '';

  const messages = [];
  if (intercomMarkdown && !intercomMarkdown.includes('*Aucun message.*')) {
    const blocks = intercomMarkdown.split(/(?=^### \[)/m).filter((b) => b.trim());
    for (const rawBlock of blocks) {
      const block = rawBlock.replace(/\n---\s*$/, '').trim();
      const header = block.match(/### \[([^\]]+)\]\s+([^|]+)\|([^|\s]+)( \[[^\]]+\])?\n([\s\S]+)/);
      if (!header) continue;
      const [, timestamp, machineId, workspace, , afterHeader] = header;
      const mid = machineId.trim();
      const ws = workspace.trim();
      let remaining = afterHeader;
      let persistedId;
      const msgMatch = remaining.match(/^\[msg: ([^\]]+)\]\n([\s\S]*)/);
      if (msgMatch) {
        persistedId = msgMatch[1];
        remaining = msgMatch[2];
      }
      const content = remaining
        .replace(/^\n/, '')
        .trim()
        .replace(/^\\#\\#\\# \[/gm, '### [')
        .replace(/^\\#\\# /gm, '## ');
      messages.push({
        id: persistedId || `idless-${++idless}-${mid}-${ws}`,
        timestamp,
        author: { machineId: mid, workspace: ws },
        content,
      });
    }
  }

  const total = Number(frontmatter.totalMessages);
  return {
    type: frontmatter.type,
    key,
    lastModified: frontmatter.lastModified,
    lastModifiedBy: undefined,
    status: { markdown: statusMarkdown },
    intercom: {
      messages,
      totalMessages: Number.isFinite(total) && total > 0 ? total : messages.length,
    },
  };
}
