/**
 * Dérivation du workspace pour les sessions/archives Claude Code (#1244, friction ai-01 du 04/10).
 *
 * Contrairement aux archives `source="roo"`, les en-têtes Claude ne portent PAS
 * de champ `workspace` : le filtre `workspace` de `list` ne pouvait donc
 * matcher aucune session Claude archivée (`matchesWorkspace(undefined, q)`
 * rend `false` par construction — utils/workspace-match.ts:20).
 *
 * Le slug de projet Claude est la seule information de chemin restante :
 * il encode le lecteur et le chemin avec des `--` (`d--Dev-CoursIA` →
 * `d:/Dev-CoursIA`, `g--Mon-Drive-Suzon` → `g:/Mon-Drive-Suzon`).
 *
 * Définition UNIQUE : le scan live des sessions Claude utilisait la même regex
 * en inline (list-conversations.tool.ts) — extraite ici pour que le scan live
 * et le constructeur d'archives partagent une seule implémentation.
 */

/** `d--Dev-CoursIA` → lecteur `d`, reste `Dev-CoursIA`. */
const DRIVE_SLUG_PATTERN = /^([a-zA-Z])--(.*)$/;

/**
 * Dérive `x:/Reste` depuis un slug de projet Claude.
 *
 * Les tirets sont conservés tels quels — un slug ne permet pas de distinguer
 * un séparateur de chemin d'un tiret littéral (ambigu, mais mieux que rien).
 */
export function deriveWorkspaceFromClaudeProjectSlug(slug: string | undefined): string | undefined {
    if (!slug) return undefined;
    const match = DRIVE_SLUG_PATTERN.exec(slug);
    if (!match) return undefined;
    const rest = match[2];
    if (!rest) return undefined;
    return `${match[1].toLowerCase()}:/${rest}`;
}

/**
 * Dérive le workspace depuis un taskId Claude — les DEUX conventions réelles :
 *
 * - **corps d'archive** : le safeSessionId NU, sans préfixe, où le `/` du chemin
 *   projet est sanitizer en `__` (`C--dev-roo-extensions__<uuid>`,
 *   `TaskArchiver.ts:38-40`, `:378`) ;
 * - **scan live / nom de fichier d'archive** : `claude-<slug>--<uuid>`
 *   (`claude-d--Dev-CoursIA--<uuid>`, `TaskArchiver.ts:348`).
 *
 * Le préfixe `claude-` est donc OPTIONNEL. La coupe se fait au **PREMIER `__`**
 * (convention archive), avec repli au **DERNIER `--`** si le corps n'en porte
 * aucun (convention live, qui n'a pas de `__`) : les sessions d'agents sont des
 * composites `<slug>__<uuid>__agent-<id>` — 78 % du corpus claude (8 638/11 108,
 * mesure 04/10, c.5981499467) — où le DERNIER `__` atterrit sur le suffixe
 * agent et pollue le slug avec l'uuid ; le PREMIER `__` est toujours la
 * frontière slug/uuid, même quand le slug porte son propre `--` de lecteur
 * (`g--Mon-Drive-Suzon`).
 *
 * Rend `undefined` quand rien n'est dérivable : les tâches roo/zoo (taskId
 * uuid-pur, sans slug de lecteur) ne matchent pas `DRIVE_SLUG_PATTERN` et
 * portent de toute façon leur propre champ `workspace`.
 */
export function deriveWorkspaceFromClaudeTaskId(taskId: string | undefined): string | undefined {
    const CLAUDE_PREFIX = 'claude-';
    if (!taskId) return undefined;
    const body = taskId.startsWith(CLAUDE_PREFIX) ? taskId.slice(CLAUDE_PREFIX.length) : taskId;
    const firstDoubleUnderscore = body.indexOf('__');
    const separator = firstDoubleUnderscore >= 0
        ? firstDoubleUnderscore
        : body.lastIndexOf('--');
    if (separator <= 0) return undefined;
    return deriveWorkspaceFromClaudeProjectSlug(body.slice(0, separator));
}
