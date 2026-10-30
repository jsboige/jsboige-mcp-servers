/**
 * #4427 PR3 — réécriture du `.env` d'un siège, clé de cascade par clé de cascade.
 *
 * Contrat (spec, § Ce qui n'est JAMAIS lu, publié ni écrit) : `apply` réécrit
 * les clés allow-listées **ligne à ligne** et préserve tout le reste **octet
 * pour octet** — fins de ligne CRLF incluses. Un `.env` réécrit par
 * concaténation ferait perdre les commentaires, l'ordre, les guillemets et les
 * clés du siège ; c'est exactement ce qu'un déploiement ne doit jamais faire.
 *
 * Ce module ne lit ni n'écrit de fichier : il transforme un TEXTE. L'écriture
 * appartient à l'appelant (et reste, in fine, un geste du propriétaire du
 * siège — « each seat owns application »).
 *
 * @module services/cascade-env-writer
 */

import type { CascadeWrite } from './cascade-sync.js';

export interface CascadeEnvWriteOutcome {
    /** Le texte réécrit (identique à l'entrée si aucune écriture ne s'applique). */
    text: string;
    /** Clés remplacées en place. */
    written: string[];
    /** Clés absentes du fichier, ajoutées en fin de fichier. */
    appended: string[];
    /** Fins de ligne détectées (`\r\n` dès qu'une ligne en porte). */
    eol: '\n' | '\r\n';
    /** Nombre de lignes hors cascade laissées intactes. */
    preservedLines: number;
}

/** Sépare un texte en lignes en CONSERVANT la fin de ligne d'origine. */
function splitKeepingEol(text: string): { lines: string[]; eols: string[] } {
    const lines: string[] = [];
    const eols: string[] = [];
    const re = /\r?\n/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        lines.push(text.slice(last, match.index));
        eols.push(match[0]);
        last = match.index + match[0].length;
    }
    // Reste éventuel (fichier sans fin de ligne finale).
    lines.push(text.slice(last));
    eols.push('');
    return { lines, eols };
}

function detectEol(eols: string[]): '\n' | '\r\n' {
    return eols.some((e) => e === '\r\n') ? '\r\n' : '\n';
}

/** Clé d'une ligne `KEY=…` (tolère `export KEY=…`), `null` si la ligne n'en porte pas. */
function keyOfLine(line: string): { key: string; eqIndex: number; exportPrefix: string } | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    const eq = line.indexOf('=');
    if (eq <= 0) return null;
    const rawKey = line.slice(0, eq);
    const exportPrefix = /^\s*export\s+/.exec(rawKey)?.[0] ?? '';
    const key = rawKey.slice(exportPrefix.length).trim();
    if (!key) return null;
    return { key, eqIndex: eq, exportPrefix };
}

/** Reprend le style de guillemets de la valeur d'origine. */
function quoteLike(originalValue: string, value: string): string {
    const trimmed = originalValue.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return `"${value}"`;
    if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return `'${value}'`;
    return value;
}

/**
 * Applique les écritures du plan au texte du `.env`.
 *
 * Une écriture dont la clé n'est pas dans le fichier est AJOUTÉE en fin de
 * fichier — un `apply` qui perdrait silencieusement une clé planifiée ferait
 * croire à une application complète. L'ajout est rapporté séparément.
 */
export function applyCascadeWrites(currentText: string, writes: CascadeWrite[]): CascadeEnvWriteOutcome {
    const { lines, eols } = splitKeepingEol(currentText);
    const eol = detectEol(eols);
    /** Un fichier sans saut de ligne final le reste : ce n'est pas à nous d'en ajouter un. */
    const endedWithEol = /(?:\r\n|\n)$/.test(currentText);
    const byKey = new Map<string, CascadeWrite>();
    for (const w of writes) byKey.set(w.key, w);

    const written: string[] = [];
    let preservedLines = 0;
    const nextLines = lines.map((line) => {
        const parsed = keyOfLine(line);
        if (!parsed) {
            preservedLines += 1;
            return line;
        }
        const write = byKey.get(parsed.key);
        if (write === undefined) {
            preservedLines += 1;
            return line;
        }
        byKey.delete(parsed.key);
        written.push(parsed.key);
        const currentValue = line.slice(parsed.eqIndex + 1);
        return `${parsed.exportPrefix}${parsed.key}=${quoteLike(currentValue, write.value)}`;
    });

    const appended = [...byKey.keys()];
    if (appended.length > 0) {
        // Le dernier segment peut être vide (fichier terminé par un saut de
        // ligne) : on insère AVANT lui pour ne pas créer de ligne fantôme.
        const trailingEmpty = nextLines.length > 0 && nextLines[nextLines.length - 1] === '';
        const insertAt = trailingEmpty ? nextLines.length - 1 : nextLines.length;
        // La ligne qui précède l'insertion doit porter un saut de ligne, sinon
        // la première clé ajoutée serait COLLÉE à elle (fichier sans fin de
        // ligne finale) — le fichier resterait syntaxiquement valide mais une
        // clé du siège serait silencieusement corrompue.
        if (insertAt > 0 && (eols[insertAt - 1] ?? '') === '') eols[insertAt - 1] = eol;
        const added = appended.map((k) => `${k}=${byKey.get(k)!.value}`);
        nextLines.splice(insertAt, 0, ...added);
        eols.splice(insertAt, 0, ...added.map(() => eol));
    }

    let text = '';
    for (let i = 0; i < nextLines.length; i++) text += nextLines[i] + (eols[i] ?? '');
    if (currentText !== '' && !endedWithEol) text = text.replace(/\r\n$|\n$/, '');

    return { text, written, appended, eol, preservedLines };
}
