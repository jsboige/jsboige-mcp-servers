// Types pour les workflows GitHub Actions
export interface ListRepositoryWorkflowsParams {
    owner: string;
    repo: string;
}

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

export interface ListRepositoryWorkflowsResult {
    success: boolean;
    workflows?: Workflow[];
    error?: string;
}

export interface GetWorkflowRunsParams {
    owner: string;
    repo: string;
    workflow_id: number; // ou string pour le nom du fichier .yml
}

export interface WorkflowRun {
    id: number;
    name?: string;
    node_id: string;
    head_branch: string;
    head_sha: string;
    run_number: number;
    event: string;
    status: string;
    conclusion: string | null;
    workflow_id: number;
    created_at: string;
    updated_at: string;
    url: string;
    html_url: string;
}

export interface GetWorkflowRunsResult {
    success: boolean;
    workflow_runs?: WorkflowRun[];
    error?: string;
}

export interface GetWorkflowRunStatusParams {
    owner: string;
    repo: string;
    run_id: number;
}

export interface GetWorkflowRunStatusResult {
    success: boolean;
    workflow_run?: WorkflowRun;
    error?: string;
}