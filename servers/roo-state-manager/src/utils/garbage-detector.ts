/**
 * Garbage task detector for skeleton cache
 * #1786 — Detect "exploded" tasks that pollute the index
 *
 * Exploded tasks are Roo/Claude sessions that consist primarily of error loops
 * (502 retries, MCP timeouts, context overflow) with zero or near-zero useful output.
 *
 * @module utils/garbage-detector
 */

import { ConversationSkeleton, MessageSkeleton, ActionMetadata } from '../types/conversation.js';

export interface GarbageVerdict {
    isGarbage: boolean;
    confidence: 'high' | 'medium' | 'low';
    reasons: string[];
    scores: {
        errorDensity: number;       // 0-1, fraction of messages that are error patterns
        assistantOutputRatio: number; // 0-1, ratio of assistant msgs with real content
        sizeEfficiency: number;     // 0-1, useful content / total size
        repetitionScore: number;    // 0-1, how repetitive the content is
    };
    totalMessages: number;
    assistantMessages: number;
    errorMessages: number;
    totalSizeBytes: number;
}

const ERROR_PATTERNS = [
    /502\s+bad\s+gateway/i,
    /502\s*error/i,
    /api\s+request\s+failed/i,
    /context\s+window\s+exceeded/i,
    /context\s+overflow/i,
    /maximum\s+context/i,
    /rate\s+limit/i,
    /timeout\s+(?:error|waiting|exceeded)/i,
    /failed\s+to\s+(?:connect|read|write|fetch|parse)/i,
    /MCP\s+(?:error|timeout|connection\s+(?:failed|refused))/i,
    /tool\s+(?:not\s+found|execution\s+failed)/i,
    /unknown\s+error/i,
    /ECONNREFUSED/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /request\s+aborted/i,
    /retry\s+(?:attempt|failed|limit)/i,
];

const MIN_MESSAGES_FOR_GARBAGE = 5;
const GARBAGE_THRESHOLD = 0.6;

function isErrorMessage(content: string): boolean {
    if (!content || typeof content !== 'string') return false;
    return ERROR_PATTERNS.some(p => p.test(content));
}

function getUniqueContentRatio(messages: MessageSkeleton[]): number {
    const contents = messages
        .filter(m => m.content && typeof m.content === 'string')
        .map(m => m.content.slice(0, 200).trim().toLowerCase());

    if (contents.length === 0) return 1;

    const unique = new Set(contents);
    return unique.size / contents.length;
}

function hasRealAssistantContent(msg: MessageSkeleton): boolean {
    if (!msg.content || typeof msg.content !== 'string') return false;
    const content = msg.content.trim();
    if (content.length < 20) return false;
    if (isErrorMessage(content)) return false;
    return true;
}

/**
 * Analyze a skeleton to determine if it's garbage (exploded task)
 */
export function detectGarbage(skeleton: ConversationSkeleton): GarbageVerdict {
    const reasons: string[] = [];
    const sequence = skeleton.sequence ?? [];
    const messages = sequence.filter((item): item is MessageSkeleton => 'role' in item);
    const actions = sequence.filter((item): item is ActionMetadata => !('role' in item));

    const totalMessages = messages.length;
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    const userMessages = messages.filter(m => m.role === 'user');

    const totalSizeBytes = skeleton.metadata.totalSize || 0;

    // Score 1: Error density — fraction of messages containing error patterns
    const errorMessages = messages.filter(m => isErrorMessage(m.content)).length;
    const errorDensity = totalMessages > 0 ? errorMessages / totalMessages : 0;

    // Score 2: Assistant output ratio — fraction of assistant msgs with real content
    const assistantWithContent = assistantMessages.filter(m => hasRealAssistantContent(m)).length;
    const assistantOutputRatio = assistantMessages.length > 0
        ? assistantWithContent / assistantMessages.length
        : 0;

    // Score 3: Size efficiency — penalize large tasks with few useful messages
    const usefulMessageCount = assistantWithContent + userMessages.filter(m => !isErrorMessage(m.content)).length;
    const sizeEfficiency = totalMessages > 0 ? usefulMessageCount / totalMessages : 1;

    // Score 4: Repetition — how much content is duplicated
    const repetitionScore = 1 - getUniqueContentRatio(messages);

    const scores = { errorDensity, assistantOutputRatio, sizeEfficiency, repetitionScore };

    // Scoring logic
    const weightedScore =
        errorDensity * 0.35 +
        (1 - assistantOutputRatio) * 0.30 +
        (1 - sizeEfficiency) * 0.20 +
        repetitionScore * 0.15;

    let isGarbage = false;
    let confidence: 'high' | 'medium' | 'low' = 'low';

    if (totalMessages >= MIN_MESSAGES_FOR_GARBAGE) {
        if (weightedScore >= GARBAGE_THRESHOLD) {
            isGarbage = true;
            confidence = weightedScore >= 0.8 ? 'high' : weightedScore >= 0.7 ? 'medium' : 'low';
        }

        // Hard rules that override the score
        if (errorDensity >= 0.8 && assistantOutputRatio <= 0.1 && totalMessages >= 10) {
            isGarbage = true;
            confidence = 'high';
            reasons.push(`${errorMessages}/${totalMessages} messages are error patterns`);
            reasons.push(`${assistantWithContent}/${assistantMessages.length} assistant messages have real content`);
        }

        if (totalSizeBytes > 500_000 && assistantOutputRatio <= 0.05 && errorDensity >= 0.5) {
            isGarbage = true;
            confidence = 'high';
            reasons.push(`Large task (${(totalSizeBytes / 1024).toFixed(0)}KB) with ${assistantOutputRatio === 0 ? 'zero' : 'negligible'} useful assistant output`);
        }
    }

    if (isGarbage && reasons.length === 0) {
        if (errorDensity > 0.5) reasons.push(`High error density: ${(errorDensity * 100).toFixed(0)}%`);
        if (assistantOutputRatio < 0.2) reasons.push(`Low assistant output: ${(assistantOutputRatio * 100).toFixed(0)}%`);
        if (repetitionScore > 0.5) reasons.push(`High repetition: ${(repetitionScore * 100).toFixed(0)}%`);
        if (sizeEfficiency < 0.3) reasons.push(`Low size efficiency: ${(sizeEfficiency * 100).toFixed(0)}%`);
    }

    return {
        isGarbage,
        confidence,
        reasons,
        scores,
        totalMessages,
        assistantMessages: assistantMessages.length,
        errorMessages,
        totalSizeBytes,
    };
}

/**
 * Scan a skeleton cache map and return garbage tasks
 */
export function scanForGarbage(
    cache: Map<string, ConversationSkeleton>,
    options?: { minConfidence?: 'low' | 'medium' | 'high' }
): Array<{ taskId: string; title?: string; verdict: GarbageVerdict }> {
    const minConfidence = options?.minConfidence ?? 'low';
    const confidenceOrder = ['low', 'medium', 'high'];
    const minIndex = confidenceOrder.indexOf(minConfidence);

    const results: Array<{ taskId: string; title?: string; verdict: GarbageVerdict }> = [];

    for (const [taskId, skeleton] of cache) {
        const verdict = detectGarbage(skeleton);
        if (verdict.isGarbage) {
            const verdictIndex = confidenceOrder.indexOf(verdict.confidence);
            if (verdictIndex >= minIndex) {
                results.push({ taskId, title: skeleton.metadata.title, verdict });
            }
        }
    }

    return results.sort((a, b) => {
        const order = confidenceOrder.indexOf;
        return confidenceOrder.indexOf(b.verdict.confidence) - confidenceOrder.indexOf(a.verdict.confidence);
    });
}
