/**
 * Types communs pour les outils MCP du roo-state-manager
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Structure standard d'un outil MCP
 */
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
}

/**
 * Structure d'un handler d'outil
 */
export interface ToolHandler<TArgs = any> {
    (args: TArgs): Promise<CallToolResult>;
}

/**
 * Outil complet avec définition et handler
 */
export interface Tool<TArgs = any> {
    definition: ToolDefinition;
    handler: ToolHandler<TArgs>;
}

// Types de paramètres courants
export interface PaginationParams {
    limit?: number;
    offset?: number;
}

export interface SortParams {
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
}

export interface WorkspaceFilter {
    workspace?: string;
}