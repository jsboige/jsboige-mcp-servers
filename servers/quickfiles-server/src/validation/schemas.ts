import { z } from 'zod';

// Zod Schemas pour la validation des entrées MCP

export const LineRangeSchema = z.object({
  start: z.number().min(1),
  end: z.number().min(1),
}).refine(data => data.end >= data.start, {
  message: "End line must be greater than or equal to start line"
});

export const FileWithExcerptsSchema = z.object({
  path: z.string(),
  excerpts: z.array(LineRangeSchema).optional(),
});

export const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.union([z.string(), FileWithExcerptsSchema])).min(1),
  show_line_numbers: z.boolean().optional().default(true),
  max_lines_per_file: z.number().min(1).optional().default(2000),
  max_chars_per_file: z.number().min(1).optional().default(160000),
  max_total_lines: z.number().min(1).optional().default(8000),
  max_total_chars: z.number().min(1).optional().default(400000),
});

export const ListDirectoryContentsArgsSchema = z.object({
  paths: z.array(z.union([z.string(), z.object({
      path: z.string(),
      recursive: z.boolean().optional(),
      max_depth: z.number().min(0).optional(),
      file_pattern: z.string().optional(),
      sort_by: z.enum(['name', 'size', 'modified']).optional(),
      sort_order: z.enum(['asc', 'desc']).optional()
  })])).min(1),
  max_lines: z.number().min(1).optional().default(1000),
  recursive: z.boolean().optional().default(false),
  max_depth: z.number().min(0).optional(),
  file_pattern: z.string().optional(),
  sort_by: z.enum(['name', 'size', 'modified']).optional().default('name'),
  sort_order: z.enum(['asc', 'desc']).optional().default('asc')
});

export const DeleteFilesArgsSchema = z.object({
  paths: z.array(z.string()).min(1),
});

export const EditMultipleFilesArgsSchema = z.object({
  files: z.array(z.object({
      path: z.string(),
      diffs: z.array(z.object({
          search: z.string(),
          replace: z.string(),
          start_line: z.number().min(1).optional(),
          use_regex: z.boolean().optional().default(false)
      }))
  })).min(1)
});

export const ExtractMarkdownStructureArgsSchema = z.object({
  paths: z.array(z.string()).min(1),
  max_depth: z.number().min(1).optional().default(6),
  include_context: z.boolean().optional().default(false),
  context_lines: z.number().min(0).optional().default(2),
});

export const FileCopyOperationSchema = z.object({
  source: z.string(),
  destination: z.string(),
  transform: z.object({
      pattern: z.string(),
      replacement: z.string()
  }).optional(),
  conflict_strategy: z.enum(['overwrite', 'ignore', 'rename']).optional().default('overwrite')
});

export const CopyFilesArgsSchema = z.object({
  operations: z.array(FileCopyOperationSchema),
});

export const MoveFilesArgsSchema = z.object({
  operations: z.array(FileCopyOperationSchema),
});

export const SearchInFilesArgsSchema = z.object({
  paths: z.array(z.string()).min(1),
  pattern: z.string(),
  use_regex: z.boolean().optional().default(true),
  case_sensitive: z.boolean().optional().default(false),
  file_pattern: z.string().optional(),
  context_lines: z.number().min(0).optional().default(2),
  max_results_per_file: z.number().min(1).optional().default(100),
  max_total_results: z.number().min(1).optional().default(1000),
  recursive: z.boolean().optional().default(true),
});

export const SearchAndReplaceBaseSchema = z.object({
    search: z.string(),
    replace: z.string(),
    use_regex: z.boolean().optional().default(true),
    case_sensitive: z.boolean().optional().default(false),
    preview: z.boolean().optional().default(false),
    paths: z.array(z.string()).optional(),
    files: z.array(z.object({
        path: z.string(),
        search: z.string().optional(),
        replace: z.string().optional(),
    })).optional(),
    file_pattern: z.string().optional(),
    recursive: z.boolean().optional().default(true),
});

export const SearchAndReplaceArgsSchema = SearchAndReplaceBaseSchema.refine(data =>
  (data.paths && data.paths.length > 0) ||
  (data.files && data.files.length > 0) ||
  (data.file_pattern && data.file_pattern.length > 0), {
  message: "Either 'paths', 'files' or 'file_pattern' must be provided",
});

export const RestartMcpServersArgsSchema = z.object({
  servers: z.array(z.string().min(1)).min(1),
});