/**
 * Types pour l'arborescence de tâches Roo State Manager
 * Phase 1 : Fondations et analyse de l'arborescence de tâches
 */
// Enums pour les types de nœuds et relations
export var TaskType;
(function (TaskType) {
    TaskType["WORKSPACE"] = "workspace";
    TaskType["PROJECT"] = "project";
    TaskType["TASK_CLUSTER"] = "task_cluster";
    TaskType["CONVERSATION"] = "conversation";
})(TaskType || (TaskType = {}));
export var RelationshipType;
(function (RelationshipType) {
    RelationshipType["PARENT_CHILD"] = "parent_child";
    RelationshipType["FILE_DEPENDENCY"] = "file_dependency";
    RelationshipType["TEMPORAL"] = "temporal";
    RelationshipType["SEMANTIC"] = "semantic";
    RelationshipType["TECHNOLOGY"] = "technology";
})(RelationshipType || (RelationshipType = {}));
export var ComplexityLevel;
(function (ComplexityLevel) {
    ComplexityLevel["SIMPLE"] = "simple";
    ComplexityLevel["MEDIUM"] = "medium";
    ComplexityLevel["COMPLEX"] = "complex";
})(ComplexityLevel || (ComplexityLevel = {}));
export var ProjectStatus;
(function (ProjectStatus) {
    ProjectStatus["ACTIVE"] = "active";
    ProjectStatus["ARCHIVED"] = "archived";
    ProjectStatus["UNKNOWN"] = "unknown";
})(ProjectStatus || (ProjectStatus = {}));
export var ConversationOutcome;
(function (ConversationOutcome) {
    ConversationOutcome["COMPLETED"] = "completed";
    ConversationOutcome["ABANDONED"] = "abandoned";
    ConversationOutcome["ONGOING"] = "ongoing";
})(ConversationOutcome || (ConversationOutcome = {}));
// Types d'erreur spécifiques à l'arborescence
export class TaskTreeError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'TaskTreeError';
    }
}
export class WorkspaceDetectionError extends TaskTreeError {
    constructor(message) {
        super(message, 'WORKSPACE_DETECTION_ERROR');
    }
}
export class ProjectClassificationError extends TaskTreeError {
    constructor(message) {
        super(message, 'PROJECT_CLASSIFICATION_ERROR');
    }
}
export class TaskClusteringError extends TaskTreeError {
    constructor(message) {
        super(message, 'TASK_CLUSTERING_ERROR');
    }
}
export class TreeBuildError extends TaskTreeError {
    constructor(message) {
        super(message, 'TREE_BUILD_ERROR');
    }
}
//# sourceMappingURL=task-tree.js.map