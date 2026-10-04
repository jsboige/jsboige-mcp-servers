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
 * Dérive le workspace depuis un taskId Claude (`claude-<slug>--<sessionUuid>`).
 * Rend `undefined` pour tout autre préfixe (les tâches roo/zoo portent leur
 * propre champ `workspace`) ou quand le slug n'est pas exploitable.
 */
export function deriveWorkspaceFromClaudeTaskId(taskId: string | undefined): string | undefined {
    const CLAUDE_PREFIX = 'claude-';
    if (!taskId || !taskId.startsWith(CLAUDE_PREFIX)) return undefined;
    const body = taskId.slice(CLAUDE_PREFIX.length);
    // Le slug peut lui-même contenir `--` : on coupe au DERNIER séparateur,
    // celui qui précède l'uuid de session.
    const separator = body.lastIndexOf('--');
    if (separator <= 0) return undefined;
    return deriveWorkspaceFromClaudeProjectSlug(body.slice(0, separator));
}
