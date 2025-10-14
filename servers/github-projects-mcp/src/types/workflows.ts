// Interfaces TypeScript pour les workflows GitHub Actions

/**
 * Paramètres pour lister les workflows d'un dépôt
 */
export interface ListRepositoryWorkflowsParams {
  owner: string;
  repo: string;
}

/**
 * Représentation d'un workflow GitHub
 */
export interface Workflow {
  id: number;
  node_id: string;
  name: string;
  path: string;
  state: 'active' | 'deleted' | 'disabled_fork' | 'disabled_inactivity' | 'disabled_manually';
  created_at: string;
  updated_at: string;
  url: string;
  html_url: string;
  badge_url: string;
}

/**
 * Résultat de la liste des workflows d'un dépôt
 */
export interface ListRepositoryWorkflowsResult {
  success: boolean;
  workflows?: Workflow[];
  error?: string;
}

/**
 * Paramètres pour récupérer les exécutions d'un workflow
 */
export interface GetWorkflowRunsParams {
  owner: string;
  repo: string;
  workflow_id: number | string; // ID numérique ou nom du fichier .yml
}

/**
 * Représentation d'une exécution de workflow
 */
export interface WorkflowRun {
  id: number;
  name: string;
  node_id: string;
  head_branch: string;
  head_sha: string;
  run_number: number;
  event: string;
  status: 'completed' | 'action_required' | 'cancelled' | 'failure' | 'neutral' | 'skipped' | 'stale' | 'success' | 'timed_out' | 'in_progress' | 'queued' | 'requested' | 'waiting' | 'pending';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  workflow_id: number;
  created_at: string;
  updated_at: string;
  url: string;
  html_url: string;
}

/**
 * Résultat des exécutions d'un workflow
 */
export interface GetWorkflowRunsResult {
  success: boolean;
  workflow_runs?: WorkflowRun[];
  error?: string;
}

/**
 * Paramètres pour récupérer le statut d'une exécution de workflow
 */
export interface GetWorkflowRunStatusParams {
  owner: string;
  repo: string;
  run_id: number;
}

/**
 * Résultat du statut d'une exécution de workflow
 */
export interface GetWorkflowRunStatusResult {
  success: boolean;
  workflow_run?: WorkflowRun;
  error?: string;
}