/**
 * Date filtering helpers shared across MCP tools.
 *
 * #1244 Couche 2.1 — Factorise les helpers de date originellement co-localises
 * dans search-semantic.tool.ts pour reutilisation par list-conversations,
 * conversation-browser, summarize, etc.
 *
 * Politique :
 *  - Accepte ISO 8601 complet (`2026-04-08T12:34:56Z`) ou raccourci YYYY-MM-DD.
 *  - Pour `endDate`, etend implicitement a fin de journee si l'heure est minuit
 *    (afin que `endDate: "2026-04-08"` inclue toute la journee du 8 avril).
 */

/**
 * Parse une chaine de date (ISO 8601 ou YYYY-MM-DD) en objet Date.
 * Retourne null si le parsing echoue.
 */
export function parseFilterDate(dateStr: string | undefined | null): Date | null {
    if (!dateStr) return null;
    try {
        // Support YYYY-MM-DD by appending T00:00:00Z; otherwise use as-is
        const d = new Date(dateStr.includes('T') ? dateStr : `${dateStr}T00:00:00Z`);
        return isNaN(d.getTime()) ? null : d;
    } catch {
        return null;
    }
}

/**
 * Etend une borne de fin a 23:59:59.999 UTC quand elle tombe a minuit —
 * semantique de `endDate: "2026-04-08"` (journee entiere incluse).
 */
export function endOfDayIfMidnight(endDate: Date): Date {
    const endOfDay = new Date(endDate.getTime());
    if (endOfDay.getUTCHours() === 0 && endOfDay.getUTCMinutes() === 0) {
        endOfDay.setUTCHours(23, 59, 59, 999);
    }
    return endOfDay;
}

/**
 * Bornes effectives d'une fenetre exprimee en chaines (ISO 8601 ou YYYY-MM-DD).
 *
 * Pour les chemins qui poussent la fenetre dans une requete (le `WHERE` SQL de
 * `PgUnifiedStoreReader.listConversations`, #2428) : la borne de fin doit etre
 * celle de `isWithinDateRange`, sinon le SQL ecarte des lignes que le filtre en
 * memoire aurait gardees (un `endDate: "2026-05-31"` nu couperait a minuit).
 */
export function resolveDateRangeBounds(
    startDate?: string | null,
    endDate?: string | null,
): { start: Date | null; end: Date | null } {
    const parsedEnd = parseFilterDate(endDate);
    return {
        start: parseFilterDate(startDate),
        end: parsedEnd ? endOfDayIfMidnight(parsedEnd) : null,
    };
}

/**
 * Verifie qu'un timestamp tombe dans la fenetre [startDate, endDate].
 * Bornes inclusives. Une borne null = pas de contrainte de ce cote.
 *
 * Si timestamp est absent / invalide ET qu'au moins une borne est fournie,
 * retourne false (filtrage strict). Si aucune borne, retourne true.
 */
export function isWithinDateRange(
    timestamp: string | undefined | null,
    startDate: Date | null,
    endDate: Date | null
): boolean {
    if (!startDate && !endDate) return true;
    if (!timestamp) return false;
    try {
        const ts = new Date(timestamp);
        if (isNaN(ts.getTime())) return false;
        if (startDate && ts < startDate) return false;
        if (endDate) {
            // For end_date given as YYYY-MM-DD, include the entire day
            if (ts > endOfDayIfMidnight(endDate)) return false;
        }
        return true;
    } catch {
        return false;
    }
}
