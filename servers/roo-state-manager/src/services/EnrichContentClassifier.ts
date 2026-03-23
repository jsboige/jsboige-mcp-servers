/**
 * EnrichContentClassifier - Service de classification enrichie du contenu
 *
 * Classifie les messages de conversation avec scoring de confiance.
 * Récupéré depuis git history (commit 6afcdfe~1, issue #813).
 * Adapté : XmlParsingService remplacé par parsing regex inline.
 */

import { ClassifiedContent, ToolCallDetails, ToolResultDetails } from '../types/enhanced-conversation.js';
import { ConversationSkeleton, MessageSkeleton } from '../types/conversation.js';

export class EnrichContentClassifier {

	/**
	 * Classifie une conversation complète
	 */
	async classifyConversationContent(conversation: ConversationSkeleton): Promise<ClassifiedContent[]> {
		const classified: ClassifiedContent[] = [];
		let index = 0;

		const messages = conversation.sequence.filter((item): item is MessageSkeleton =>
			'role' in item && 'content' in item);

		for (const message of messages) {
			const classifiedMessage = await this.classifyMessage(message.content, message.role, index++);
			classified.push(classifiedMessage);
		}

		return classified;
	}

	/**
	 * Classifie un message individuel avec enrichissement
	 */
	async classifyMessage(content: string, role: 'user' | 'assistant', index: number): Promise<ClassifiedContent> {
		const contentSize = content.length;
		let type: 'User' | 'Assistant';
		let subType: ClassifiedContent['subType'];
		let toolCallDetails: ToolCallDetails | undefined;
		let toolResultDetails: ToolResultDetails | undefined;
		let confidenceScore = 1.0;

		if (role === 'user') {
			type = 'User';
			if (this.isToolResult(content)) {
				subType = 'ToolResult';
				toolResultDetails = this.extractToolResultDetails(content);
				confidenceScore = 0.95;
			} else {
				subType = 'UserMessage';
				confidenceScore = 0.9;
			}
		} else {
			type = 'Assistant';
			if (this.isCompletionMessage(content)) {
				subType = 'Completion';
				confidenceScore = 0.98;
			} else if (this.isThinkingMessage(content)) {
				subType = 'Thinking';
				confidenceScore = 0.85;
			} else if (this.hasToolCalls(content)) {
				subType = 'ToolCall';
				toolCallDetails = this.extractToolCallDetails(content);
				confidenceScore = toolCallDetails?.parseSuccess ? 0.92 : 0.7;
			} else {
				subType = 'Completion';
				confidenceScore = 0.8;
			}
		}

		const isRelevant = this.evaluateRelevance(content, subType, contentSize);
		confidenceScore = this.adjustConfidenceScore(confidenceScore, content, contentSize);

		return {
			type, subType, content, index, contentSize,
			isRelevant, confidenceScore, toolCallDetails, toolResultDetails
		};
	}

	private isToolResult(content: string): boolean {
		return /\[[^\]]+\]\s*Result:/i.test(content) ||
			/Command executed/i.test(content) ||
			/<file_write_result>/i.test(content);
	}

	private isCompletionMessage(content: string): boolean {
		return /<attempt_completion>/i.test(content);
	}

	private isThinkingMessage(content: string): boolean {
		return /<thinking>/i.test(content);
	}

	private hasToolCalls(content: string): boolean {
		return /<\w+_\w+>[\s\S]*?<\/\w+_\w+>/i.test(content) ||
			/<read_file>/i.test(content) ||
			/<write_to_file>/i.test(content) ||
			/<execute_command>/i.test(content);
	}

	/**
	 * Extrait les détails des appels d'outils (regex, pas de dep XML externe)
	 */
	private extractToolCallDetails(content: string): ToolCallDetails {
		try {
			const toolCallMatch = content.match(/<(\w+)>([\s\S]*?)<\/\1>/);
			if (!toolCallMatch) {
				return {
					toolName: 'unknown', arguments: {}, rawXml: '',
					parseSuccess: false, parseError: 'No tool call pattern found'
				};
			}

			const toolName = toolCallMatch[1];
			const rawXml = toolCallMatch[0];
			const innerContent = toolCallMatch[2];

			// Parse simple des arguments via regex (remplace XmlParsingService)
			const args: Record<string, string> = {};
			const argPattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
			let match;
			while ((match = argPattern.exec(innerContent)) !== null) {
				args[match[1]] = match[2].trim();
			}

			return {
				toolName, arguments: args, rawXml,
				parseSuccess: true
			};
		} catch (error) {
			return {
				toolName: 'error', arguments: {},
				rawXml: content.substring(0, 200),
				parseSuccess: false,
				parseError: error instanceof Error ? error.message : 'Unknown parsing error'
			};
		}
	}

	private extractToolResultDetails(content: string): ToolResultDetails {
		let success = true;
		let resultType: ToolResultDetails['resultType'] = 'text';
		let truncated = false;
		let originalLength: number | undefined;
		let errorMessage: string | undefined;

		if (/<file_write_result>/i.test(content) || /<files>/i.test(content)) {
			resultType = 'file';
		} else if (/{[\s\S]*}/i.test(content)) {
			resultType = 'json';
		} else if (/<html/i.test(content)) {
			resultType = 'html';
		}

		if (/error|failed|unable/i.test(content)) {
			success = false;
			resultType = 'error';
			const errorMatch = content.match(/error:\s*([^\n]+)/i);
			errorMessage = errorMatch ? errorMatch[1].trim() : 'Unknown error';
		}

		if (/truncated|\.{3}|…/.test(content)) {
			truncated = true;
			const lengthMatch = content.match(/(\d+)\s*(characters?|chars?|bytes?)/i);
			originalLength = lengthMatch ? parseInt(lengthMatch[1]) : undefined;
		}

		return { success, outputSize: content.length, resultType, truncated, originalLength, errorMessage };
	}

	private evaluateRelevance(content: string, subType: string, contentSize: number): boolean {
		if (contentSize < 10) return false;
		if (/^debug|^log:|console\./i.test(content.trim())) return false;
		if (/<environment_details>/i.test(content)) return false;
		if (subType === 'Completion') return true;
		return true;
	}

	private adjustConfidenceScore(baseScore: number, content: string, contentSize: number): number {
		let score = baseScore;
		if (contentSize < 20) score *= 0.8;
		if (contentSize > 10000) score *= 0.9;
		if (/^#|^\*\*|^-/.test(content.trim())) score *= 1.1;

		const words = content.toLowerCase().split(/\s+/);
		const uniqueWords = new Set(words);
		if (words.length > 10 && uniqueWords.size / words.length < 0.3) {
			score *= 0.7;
		}

		return Math.max(0, Math.min(1, score));
	}
}
