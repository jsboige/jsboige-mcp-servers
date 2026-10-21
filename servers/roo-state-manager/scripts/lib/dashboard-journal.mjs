/**
 * #4131 grain G-C — pure logic for the WAKE listener's PG helpers
 * (`rsm-dashboard-intercom.mjs`, `rsm-dashboard-append.mjs`).
 *
 * Design po-2026 08/10 11:23Z, reassigned to myia-po-2023:roo-extensions
 * (c.6144244050). The listener stops reading/writing the GDrive dashboard
 * files as its primary path: sites 1-3 (read, discover, fallback poll) query
 * the PG journal, site 4 (escalations) appends through the same dual-write
 * the MCP tool uses.
 *
 * Everything here is I/O-free and unit-tested; the CLIs stay thin. The SQL
 * mirrors the reader's own journal query verbatim (`PgUnifiedStoreReader.
 * getRooSyncDashboard`: archived_at IS NULL, ORDER BY created_at ASC, id ASC)
 * so the listener and the seats it serves cannot disagree on message order.
 */

// ── SQL (parameterized; $n placeholders) ────────────────────────────────────

/** Site 1 — intercom messages of one dashboard, newer than a cursor. */
export const SQL_INTERCOM_SINCE = `
  SELECT message_id, author_machine, author_workspace, content, created_at
    FROM roosync_dashboard_messages
   WHERE dashboard_key = $1
     AND created_at > $2
     AND archived_at IS NULL
   ORDER BY created_at ASC, id ASC
`;

/** Site 2 — auto-discovery of workspace dashboard keys (row table, not the
 *  journal: a workspace whose every message is archived still exists). The
 *  row table's key column is `key` (aliased for the consumer). */
export const SQL_DISCOVER_WORKSPACES = `
  SELECT DISTINCT key AS dashboard_key
    FROM roosync_dashboards
   WHERE key LIKE 'workspace-%'
   ORDER BY key ASC
`;

/** Site 3 — fallback poll trigger: latest live message per watched key, one
 *  grouped query (design: replaces the GDrive mtime cache). */
export const SQL_MAX_CREATED = `
  SELECT dashboard_key, MAX(created_at) AS max_created
    FROM roosync_dashboard_messages
   WHERE dashboard_key = ANY($1::text[])
     AND archived_at IS NULL
   GROUP BY dashboard_key
`;

// ── Row → listener shape (site 1 mapping) ──────────────────────────────────

/**
 * Map a PG journal row to the listener's message shape
 * (`{timestamp, content, author:{machineId, workspace}}` — the exact shape
 * `Read-DashboardMessages` returns today, so `Invoke-ProcessWorkspace` and
 * the WAKE routing functions are unchanged).
 *
 * `created_at` arrives as a JS Date through node-postgres (timestamptz);
 * toISOString() converges with the markdown header format
 * `yyyy-MM-ddTHH:mm:ss.fffZ` the listener acks against (design parity note).
 */
export function rowToListenerMessage(row) {
  if (!row || typeof row !== 'object') {
    throw new Error('rowToListenerMessage: row requis');
  }
  const created = row.created_at;
  const timestamp =
    created instanceof Date
      ? created.toISOString()
      : created !== null && created !== undefined
        ? String(created)
        : null;
  return {
    timestamp,
    content: row.content === null || row.content === undefined ? '' : String(row.content),
    author: {
      machineId: row.author_machine === null || row.author_machine === undefined ? '' : String(row.author_machine),
      workspace: row.author_workspace === null || row.author_workspace === undefined ? '' : String(row.author_workspace),
    },
  };
}

// ── Escalation content guard (#3761 condition 1) ───────────────────────────

const FORBIDDEN_ESCALATION_TAGS = new Set(['ERROR']);

/**
 * The escalation surface may never carry an ERROR-classified tag
 * (#3761 condition 1: machine dashboards only, no ERROR), and must be
 * tag-prefixed so fleet health can classify what it reads. First non-empty
 * line decides; everything else is prose.
 *
 * @returns {{ok: true, tag: string} | {ok: false, error: string}}
 */
export function validateEscalationContent(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, error: 'contenu vide' };
  }
  const firstLine = content.split(/\r?\n/, 1)[0].trim();
  const tagMatch = firstLine.match(/^\[([A-Za-z_-]+)\]/);
  if (!tagMatch) {
    return { ok: false, error: `première ligne sans préfixe [TAG] : « ${firstLine.slice(0, 60)} »` };
  }
  const tag = tagMatch[1].toUpperCase();
  if (FORBIDDEN_ESCALATION_TAGS.has(tag)) {
    return { ok: false, error: `tag [${tagMatch[1]}] interdit sur l'escalade machine (#3761 condition 1)` };
  }
  return { ok: true, tag };
}

// ── Escalation message + dashboard state (site 4, pure halves) ─────────────

/**
 * Build the escalation message at parity with the current
 * `Write-MachineDashboardMessage` conventions: author `<machine>|listener`
 * (here machineId + workspace 'listener'), msg id
 * `<machine>:listener:ic-<yyyyMMddTHHmmss>-<4 rand>`, RFC-3339 stamp.
 *
 * `rand` is injected (not Math.random) so tests are deterministic.
 */
export function buildListenerEscalationMessage({ machineId, content, nowIso, rand }) {
  if (!machineId || typeof machineId !== 'string') {
    throw new Error('buildListenerEscalationMessage: machineId requis');
  }
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) {
    throw new Error(`buildListenerEscalationMessage: nowIso invalide « ${nowIso} »`);
  }
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  // 20261014T012345Z → compact 20261014T012345 (parity with the PS format
  // 'yyyyMMddTHHmmss' — no seconds fraction, no trailing Z).
  const compact = stamp.replace(/Z$/, '');
  return {
    id: `${machineId}:listener:ic-${compact}-${rand}`,
    timestamp: now.toISOString(),
    author: { machineId, workspace: 'listener' },
    content,
  };
}

/**
 * Pure fold of one message into a dashboard state — the minimal twin of what
 * `handleAppend` does for the escalation path (no condensation: escalations
 * are rare, deduped, and never near the size thresholds). Input is never
 * mutated; a shallow-copied state is returned.
 */
export function nextDashboardState(dashboard, message) {
  if (!dashboard || !Array.isArray(dashboard.intercom?.messages)) {
    throw new Error('nextDashboardState: dashboard.intercom.messages requis');
  }
  if (!message || typeof message !== 'object') {
    throw new Error('nextDashboardState: message requis');
  }
  const total = dashboard.intercom.totalMessages ?? dashboard.intercom.messages.length;
  return {
    ...dashboard,
    lastModified: message.timestamp,
    lastModifiedBy: { machineId: message.author.machineId, workspace: message.author.workspace },
    intercom: {
      ...dashboard.intercom,
      messages: [...dashboard.intercom.messages, message],
      totalMessages: total + 1,
    },
  };
}

// ── CLI arg grammar (shared, testable) ──────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

// ── #4090 fleet append surface (general targets + stable id) ────────────────

/**
 * Fleet-surface content guard: same [TAG] requirement as the escalation
 * guard, but [ERROR] is legitimate here — watchdog DOWN alerts belong on the
 * global/workspace channels (#4090). The machine-escalation guard
 * (`validateEscalationContent`) is untouched and stays the default path.
 */
export function validateTaggedContent(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, error: 'contenu vide' };
  }
  const firstLine = content.split(/\r?\n/, 1)[0].trim();
  const tagMatch = firstLine.match(/^\[([A-Za-z_-]+)\]/);
  if (!tagMatch) {
    return { ok: false, error: `première ligne sans préfixe [TAG] : « ${firstLine.slice(0, 60)} »` };
  }
  return { ok: true, tag: tagMatch[1].toUpperCase() };
}

/**
 * Grammar of the append CLI. Two modes:
 *   (default) --machine <id> + content            → machine-<id> escalation
 *             (WARN-class only, author listener, generated id — unchanged)
 *   --dashboard <global|workspace:<name>>         → fleet append, REQUIRES
 *             --message-id <stable> (idempotence #4090: a re-post with the
 *             same id is a no-op), author workspace via --author-workspace.
 *
 * `--message-id`/`--author-workspace` without `--dashboard` are refused: the
 * escalation id is generated by contract, and allowing an external id there
 * would reopen exactly the duplicate class #4090 closes.
 *
 * @returns {object | {error: string}}
 */
export function parseAppendArgs(argv) {
  if (!Array.isArray(argv)) return { error: 'argv requis' };
  const known = new Set([
    '--machine',
    '--content-file',
    '--content',
    '--dashboard',
    '--message-id',
    '--author-workspace',
    '--help',
    '-h',
  ]);
  for (const a of argv) {
    if (a.startsWith('--') && !known.has(a)) return { error: `option inconnue « ${a} »` };
  }
  const machine = flagValue(argv, '--machine');
  const contentFile = flagValue(argv, '--content-file');
  const contentInline = flagValue(argv, '--content');
  const dashboard = flagValue(argv, '--dashboard');
  const messageId = flagValue(argv, '--message-id');
  const authorWorkspace = flagValue(argv, '--author-workspace');

  if (!machine || machine.trim() === '') return { error: '--machine <id> requis' };
  if ((contentFile === undefined) === (contentInline === undefined)) {
    return { error: 'exactement une source de contenu : --content-file <f> OU --content <texte>' };
  }
  if (dashboard === undefined) {
    if (messageId !== undefined) {
      return { error: '--message-id exige --dashboard (l’id de l’escalade machine est généré)' };
    }
    if (authorWorkspace !== undefined) {
      return { error: '--author-workspace exige --dashboard' };
    }
    return {
      mode: 'escalation',
      machineId: machine.trim(),
      contentFile,
      contentInline,
      dashboard: null,
      messageId: null,
      authorWorkspace: 'listener',
    };
  }
  let target;
  if (dashboard === 'global') {
    target = { type: 'global', workspace: null };
  } else {
    const ws = /^workspace:([A-Za-z0-9._-]+)$/.exec(dashboard);
    if (!ws) return { error: '--dashboard attend « global » ou « workspace:<nom> »' };
    target = { type: 'workspace', workspace: ws[1] };
  }
  if (messageId === undefined || messageId.trim() === '') {
    return { error: '--message-id <id stable> requis avec --dashboard (idempotence #4090)' };
  }
  if (!MESSAGE_ID_RE.test(messageId)) {
    return { error: `--message-id invalide « ${messageId} » (charset [A-Za-z0-9._:-], ≤128)` };
  }
  return {
    mode: 'dashboard',
    machineId: machine.trim(),
    contentFile,
    contentInline,
    dashboard: target,
    messageId,
    authorWorkspace: authorWorkspace ?? 'listener',
  };
}

/**
 * Build one append message. With `messageId`, the id is used VERBATIM — that
 * is the idempotence key the watchdogs need (#4090). Without one, the id
 * follows the listener convention `<machine>:<workspace>:ic-<stamp>-<rand>`.
 * `rand` is injected so tests are deterministic.
 */
export function buildAppendMessage({ machineId, workspace, content, messageId, nowIso, rand }) {
  if (!machineId || typeof machineId !== 'string') {
    throw new Error('buildAppendMessage: machineId requis');
  }
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) {
    throw new Error(`buildAppendMessage: nowIso invalide « ${nowIso} »`);
  }
  const ws = workspace || 'listener';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace(/Z$/, '');
  return {
    id: messageId || `${machineId}:${ws}:ic-${stamp}-${rand}`,
    timestamp: now.toISOString(),
    author: { machineId, workspace: ws },
    content,
  };
}

/**
 * True when the dashboard already carries a message with this id. The fold is
 * skipped in that case (no new message, no counter bump, no write): re-posting
 * the same stable id is a no-op by contract (#4090).
 */
export function shouldDeduplicate(dashboard, messageId) {
  if (!messageId || !dashboard || !Array.isArray(dashboard.intercom?.messages)) return false;
  return dashboard.intercom.messages.some((m) => m && m.id === messageId);
}

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

/**
 * Grammar of `rsm-dashboard-intercom.mjs`. Exactly one mode:
 *   (default) --workspace <ws> [--since <iso>]   → messages since cursor
 *   --discover                                     → workspace key list
 *   --max-created <ws,ws,…>                        → poll trigger map
 *
 * Unknown flags are refused — the read surface carries no `--type` and no
 * write path, by construction (fail-closed on typos instead of silently
 * ignoring them).
 *
 * @returns {{mode, workspace?, since?, keys?} | {error: string}}
 */
export function parseIntercomArgs(argv) {
  if (!Array.isArray(argv)) return { error: 'argv requis' };
  const known = new Set(['--workspace', '--since', '--discover', '--max-created', '--help', '-h']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && !known.has(argv[i])) {
      return { error: `option inconnue « ${argv[i]} » (surface lecture seule : --workspace/--since/--discover/--max-created)` };
    }
  }
  const help = argv.includes('--help') || argv.includes('-h');
  const discover = argv.includes('--discover');
  const maxCreated = flagValue(argv, '--max-created');
  const workspace = flagValue(argv, '--workspace');
  const since = flagValue(argv, '--since');
  if (help) return { mode: 'help' };
  const modes = [discover, maxCreated !== undefined, workspace !== undefined].filter(Boolean).length;
  if (modes !== 1) {
    return { error: 'exactement un mode requis : --workspace <ws> | --discover | --max-created <ws,ws…>' };
  }
  if (discover) return { mode: 'discover' };
  if (maxCreated !== undefined) {
    const keys = maxCreated.split(',').map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) return { error: '--max-created exige ≥1 workspace (liste à virgules)' };
    return { mode: 'max-created', keys };
  }
  if (!workspace || workspace.trim() === '') return { error: '--workspace exige un nom non vide' };
  if (since !== undefined && !ISO_RE.test(since)) {
    return { error: `--since attend un ISO-8601 (yyyy-MM-ddTHH:mm:ss[.fff]Z), reçu « ${since} »` };
  }
  return { mode: 'messages', workspace: workspace.trim(), since: since ?? null };
}
