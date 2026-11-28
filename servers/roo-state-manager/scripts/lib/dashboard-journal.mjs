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

/** #4131 G-DASH — activity count for the statusline: dashboards that received
 *  at least one live message in the last `$1` hours, with their latest stamp.
 *
 *  Replaces the `*.md` mtime walk the statusline used for its "N dash" cell.
 *  Once the per-append file mirror is off, the files are periodic exports: an
 *  mtime no longer says "this dashboard was active", only "an export tick
 *  touched it". The journal is the surface that still carries activity. */
export const SQL_RECENT_KEYS = `
  SELECT dashboard_key, MAX(created_at) AS max_created
    FROM roosync_dashboard_messages
   WHERE archived_at IS NULL
     AND created_at > now() - ($1::int * interval '1 hour')
   GROUP BY dashboard_key
   ORDER BY max_created DESC
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

// Identity of a message across two reads of the same key that do NOT come from
// the same half (PG rows vs the parsed file). An id only counts when it was
// persisted (`[msg: …]`): `parseDashboardMarkdown` synthesizes a FRESH id at
// every parse for a block that carries none (dashboard-markdown.ts), so an
// id-only comparison would see a "file-only addition" in every id-less block.
// The content key is what survives the file round-trip (CRLF → LF, trimmed
// block) — same basis as the module's own `intercomMessageFingerprint`.
const messageKey = (m) =>
  `${m.timestamp}|${m.author?.machineId}|${m.author?.workspace}|${String(m.content ?? '').replace(/\r\n/g, '\n').trim()}`;

/**
 * #4915 (review ms#1919): the messages a FILE state holds that `state` does
 * not. `readDashboardFile` answers from PG as soon as the key has a readable
 * row there, so an append whose own PG attempt failed — it exists only in the
 * file — is invisible to that read. Returns the file messages absent from
 * `state`, in file order; empty when the file holds nothing more.
 */
export function fileOnlyMessages(state, fileState) {
  const own = state?.intercom?.messages ?? [];
  const ownIds = new Set(own.map((m) => m.id));
  const ownKeys = new Set(own.map(messageKey));
  return (fileState?.intercom?.messages ?? []).filter(
    (m) => !ownIds.has(m.id) && !ownKeys.has(messageKey(m))
  );
}

/**
 * Same read, with the file-only messages folded in: base order, then the
 * file-only ones in file order. The counter never goes down. Returns `state`
 * itself when there is nothing to fold. The input is never mutated.
 */
export function withFileOnlyMessages(state, fileState) {
  const extra = fileOnlyMessages(state, fileState);
  if (extra.length === 0) {
    return state;
  }
  const total = (d) => d.intercom.totalMessages ?? d.intercom.messages.length;
  return {
    ...state,
    intercom: {
      ...state.intercom,
      messages: [...state.intercom.messages, ...extra],
      totalMessages: Math.max(total(state), total(fileState)),
    },
  };
}

/**
 * #4915 (tier-2 review ai-01, 26/11 blocker 1): a STATUS change writes no
 * message, so `fileOnlyMessages` is blind to it — a file whose status was
 * updated during the PG attempt looks unchanged, and a mirror rendered from
 * the pre-attempt base replaces it, then stamps the result `mirrorExportAt`
 * ("up to date" while PG holds the older status).
 *
 * Returns true when the file's status DIFFERS from `state`'s and the file is
 * not provably older: only then may the file not be replaced. A file that is
 * merely BEHIND the base (its `lastModified` precedes the base's — the normal
 * state of a mirror between two exports) is still mirrored: the status in
 * `state` is the newer one, and refusing would freeze the file for good.
 * An empty status on the file carries no claim to lose (older renderers wrote
 * no section), and an undated file makes no freshness claim either.
 */
export function fileStatusSupersedes(state, fileState) {
  const fileStatus = fileState?.status?.markdown;
  if (typeof fileStatus !== 'string' || fileStatus.trim() === '') return false;
  const stateStatus = state?.status?.markdown;
  if (fileStatus.trim() === String(stateStatus ?? '').trim()) return false;
  const fileAt = Date.parse(fileState?.lastModified ?? '');
  if (Number.isNaN(fileAt)) return false;
  const stateAt = Date.parse(state?.lastModified ?? '');
  // An undated base cannot prove the file stale: the file's claim stands.
  if (Number.isNaN(stateAt)) return true;
  return fileAt >= stateAt;
}

/**
 * #4915 follow-up (re-review ms#1919, web1 27/11): preserve is not carry.
 * `fileStatusSupersedes` made the mirror SKIP, so the file kept a status PG had
 * never received — and that preservation lasts one append at most: the base's
 * `lastModified` advances with every append (`nextDashboardState`), after which
 * the helper answers false and the next mirror renders the stale PG status over
 * the newer one — on BOTH surfaces. The status is then lost for good.
 *
 * Returns `state` with the file's status carried into it (field-wise, the file
 * wins on `markdown`), so the caller can report that status to PG and then
 * render a mirror that is a TRUE export of what PG holds. Inputs are never
 * mutated; a file without a status carries nothing and `state` is returned
 * as-is.
 */
export function withFileStatus(state, fileState) {
  const fileStatus = fileState?.status;
  if (!fileStatus || typeof fileStatus.markdown !== 'string') return state;
  return { ...state, status: { ...(state?.status ?? {}), ...fileStatus } };
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
 * `--recent-keys <hours>` is a MODIFIER of `--workspace` (not a mode): it
 * adds a `recentKeys` block to the same response — the dashboards that saw a
 * live message in that window. One process, one connection, one round-trip:
 * the statusline replaced its `*.md` mtime walk with it (#4131 G-DASH) and
 * cannot afford a second node+PG spawn per render.
 *
 * Unknown flags are refused — the read surface carries no `--type` and no
 * write path, by construction (fail-closed on typos instead of silently
 * ignoring them).
 *
 * @returns {{mode, workspace?, since?, recentHours?, keys?} | {error: string}}
 */
export function parseIntercomArgs(argv) {
  if (!Array.isArray(argv)) return { error: 'argv requis' };
  const known = new Set(['--workspace', '--since', '--discover', '--max-created', '--recent-keys', '--help', '-h']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && !known.has(argv[i])) {
      return { error: `option inconnue « ${argv[i]} » (surface lecture seule : --workspace/--since/--discover/--max-created/--recent-keys)` };
    }
  }
  const help = argv.includes('--help') || argv.includes('-h');
  const discover = argv.includes('--discover');
  const maxCreated = flagValue(argv, '--max-created');
  const workspace = flagValue(argv, '--workspace');
  const since = flagValue(argv, '--since');
  const recentFlag = argv.includes('--recent-keys');
  const recentRaw = flagValue(argv, '--recent-keys');
  if (help) return { mode: 'help' };
  const modes = [discover, maxCreated !== undefined, workspace !== undefined].filter(Boolean).length;
  if (modes !== 1) {
    return { error: 'exactement un mode requis : --workspace <ws> | --discover | --max-created <ws,ws…>' };
  }
  if (recentFlag && (discover || maxCreated !== undefined)) {
    return { error: '--recent-keys accompagne --workspace <ws>, pas --discover ni --max-created' };
  }
  if (recentFlag && recentRaw === undefined) {
    return { error: '--recent-keys exige un nombre d\'heures' };
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
  let recentHours;
  if (recentFlag) {
    const hours = Number(recentRaw);
    if (!Number.isInteger(hours) || hours < 1 || hours > 8760) {
      return { error: `--recent-keys attend un entier d'heures (1-8760), reçu « ${recentRaw} »` };
    }
    recentHours = hours;
  }
  return {
    mode: 'messages',
    workspace: workspace.trim(),
    since: since ?? null,
    // Absent par défaut : l'égalité exacte des appelants existants ne bouge pas.
    ...(recentHours !== undefined ? { recentHours } : {}),
  };
}
