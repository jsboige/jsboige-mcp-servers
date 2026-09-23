/**
 * Shared text-preview helpers for conversation listings and stub builders.
 *
 * Extracted from list-conversations.tool.ts (#3661) so Tier 3 archive stubs
 * compute the exact same previews the listing would extract from a full
 * sequence — without creating a services → tools import cycle.
 */

/**
 * Strip XML-ish wrapper tags and BOM from message content before preview.
 * These are Roo/JSONL internal artifacts that add noise to list output.
 */
export function stripXmlTags(text?: string): string | undefined {
    if (!text) return undefined;
    return text
        .replace(/^﻿/, '') // Strip BOM (Claude session metadata)
        .replace(/<\/?user_message>/g, '')
        .replace(/<\/?task>/g, '')
        .replace(/^\s*\n/, '') // leading blank line after tag removal
        .trim() || undefined;
}

/**
 * Truncate text at the last word/sentence boundary within maxLength.
 * Avoids cutting mid-word, producing cleaner snippets for conversation_browser list.
 */
export function truncateAtBoundary(text: string, maxLength: number): string {
    if (!text || text.length <= maxLength) return text;
    // Try sentence boundary first (. ! ? followed by space)
    const sentenceCut = text.lastIndexOf('. ', maxLength - 2);
    if (sentenceCut > maxLength * 0.4) {
        return text.substring(0, sentenceCut + 1);
    }
    // Try word boundary
    const wordCut = text.lastIndexOf(' ', maxLength - 2);
    if (wordCut > maxLength * 0.4) {
        return text.substring(0, wordCut) + '...';
    }
    // Fallback: hard cut
    return text.substring(0, maxLength - 3) + '...';
}
