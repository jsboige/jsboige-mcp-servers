// Interfaces et types pour QuickFiles Server

export interface LineRange { 
  start: number; 
  end: number; 
}

export interface FileWithExcerpts { 
  path: string; 
  excerpts?: LineRange[]; 
}

export interface FileDiff { 
  search: string; 
  replace: string; 
  start_line?: number; 
}

export interface FileEdit { 
  path: string; 
  diffs: FileDiff[]; 
}

export interface MarkdownHeading { 
  text: string; 
  level: number; 
  line: number; 
  context?: string[]; 
}

export interface FileCopyOperation { 
  source: string; 
  destination: string; 
  transform?: { pattern: string; replacement: string; }; 
  conflict_strategy?: 'overwrite' | 'ignore' | 'rename'; 
}

export interface FileOperationResult {
  path: string;
  success: boolean;
  error?: string;
  modifications?: number;
  errors?: string[];
  skipped?: boolean;
  message?: string;
  source?: string;
  destination?: string;
}

export interface FileCopyResult {
  source: string;
  destination: string;
  success: boolean;
  files: FileOperationResult[];
  error?: string;
}

export interface SearchResult {
  path: string;
  matches: SearchMatch[];
}

export interface SearchMatch {
  lineNumber: number;
  line: string;
  context: string[];
}

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  size: number | null;
  modified: number | null;
  lines: number;
}

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
  error?: string;
}

export interface MarkdownStructureResult {
  path: string;
  headings?: MarkdownHeading[];
  error?: string;
}

export interface SearchAndReplaceOptions {
  useRegex?: boolean;
  caseSensitive?: boolean;
  preview?: boolean;
  file_pattern?: string;
  recursive?: boolean;
}

export interface ReplaceResult {
  modified: boolean;
  diff: string;
  replacements?: number;
  warning?: string;
}

export interface ProcessFilesResult {
  totalReplacements: number;
  diffs: string;
}

export interface RestartServerResult {
  server: string;
  status: 'success' | 'error';
  reason?: string;
}