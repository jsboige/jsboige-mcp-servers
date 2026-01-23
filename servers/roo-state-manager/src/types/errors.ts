/**
 * Types d'erreurs structurés pour RooSync State Manager
 *
 * Ce fichier définit les codes d'erreur et les classes d'erreur
 * pour une gestion explicite et cohérente des erreurs dans tous les services.
 */

/**
 * Catégories d'erreur pour distinguer les erreurs script vs système
 * (T3.7 - Différencier erreurs script vs système)
 */
export enum ErrorCategory {
  SCRIPT = 'SCRIPT',           // Bug dans le code PowerShell (syntaxe, logique, variables)
  SYSTEM = 'SYSTEM',           // Problème système (fichier, réseau, permissions, timeout)
  UNKNOWN = 'UNKNOWN'          // Impossible à déterminer automatiquement
}

/**
 * Classe de base pour toutes les erreurs du State Manager
 */
export class StateManagerError extends Error {
  public readonly code: string;
  public readonly service: string;
  public readonly details?: any;
  public readonly cause?: Error;
  public readonly category: ErrorCategory;  // T3.7: Catégorie d'erreur

  constructor(
    message: string,
    code: string,
    service: string,
    details?: any,
    cause?: Error,
    category: ErrorCategory = ErrorCategory.UNKNOWN  // T3.7: Catégorie par défaut
  ) {
    super(message);
    this.name = 'StateManagerError';
    this.code = code;
    this.service = service;
    this.details = details;
    this.cause = cause;
    this.category = category;

    // Maintient la trace de la pile d'appels correcte
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StateManagerError);
    }
  }

  /**
   * Retourne une représentation JSON de l'erreur
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      service: this.service,
      category: this.category,  // T3.7: Inclure la catégorie
      details: this.details,
      cause: this.cause ? {
        name: this.cause.name,
        message: this.cause.message
      } : undefined
    };
  }
}

/**
 * Codes d'erreur pour ConfigService
 */
export enum ConfigServiceErrorCode {
  CONFIG_NOT_FOUND = 'CONFIG_NOT_FOUND',
  CONFIG_LOAD_FAILED = 'CONFIG_LOAD_FAILED',
  CONFIG_SAVE_FAILED = 'CONFIG_SAVE_FAILED',
  CONFIG_INVALID = 'CONFIG_INVALID',
  CONFIG_VERSION_READ_FAILED = 'CONFIG_VERSION_READ_FAILED',
  CONFIG_PATH_NOT_FOUND = 'CONFIG_PATH_NOT_FOUND',
  SHARED_STATE_PATH_NOT_FOUND = 'SHARED_STATE_PATH_NOT_FOUND'
}

/**
 * Erreur spécifique pour ConfigService
 */
export class ConfigServiceError extends StateManagerError {
  constructor(
    message: string,
    code: ConfigServiceErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'ConfigService', details, cause);
    this.name = 'ConfigServiceError';
  }
}

/**
 * Codes d'erreur pour IdentityManager
 */
export enum IdentityManagerErrorCode {
  REGISTRY_LOAD_FAILED = 'REGISTRY_LOAD_FAILED',
  REGISTRY_SAVE_FAILED = 'REGISTRY_SAVE_FAILED',
  COLLECTION_FAILED = 'COLLECTION_FAILED',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  IDENTITY_CONFLICT = 'IDENTITY_CONFLICT',
  IDENTITY_NOT_FOUND = 'IDENTITY_NOT_FOUND',
  CLEANUP_FAILED = 'CLEANUP_FAILED',
  PRESENCE_READ_FAILED = 'PRESENCE_READ_FAILED',
  BASELINE_READ_FAILED = 'BASELINE_READ_FAILED',
  DASHBOARD_READ_FAILED = 'DASHBOARD_READ_FAILED'
}

/**
 * Erreur spécifique pour IdentityManager
 */
export class IdentityManagerError extends StateManagerError {
  constructor(
    message: string,
    code: IdentityManagerErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'IdentityManager', details, cause);
    this.name = 'IdentityManagerError';
  }
}

/**
 * Codes d'erreur pour BaselineLoader
 */
export enum BaselineLoaderErrorCode {
  BASELINE_NOT_FOUND = 'BASELINE_NOT_FOUND',
  BASELINE_LOAD_FAILED = 'BASELINE_LOAD_FAILED',
  BASELINE_INVALID = 'BASELINE_INVALID',
  BASELINE_PARSE_FAILED = 'BASELINE_PARSE_FAILED',
  BASELINE_TRANSFORM_FAILED = 'BASELINE_TRANSFORM_FAILED',
  BASELINE_VALIDATION_FAILED = 'BASELINE_VALIDATION_FAILED',
  BASELINE_READ_FAILED = 'BASELINE_READ_FAILED'
}

/**
 * Erreur spécifique pour BaselineLoader
 */
export class BaselineLoaderError extends StateManagerError {
  constructor(
    message: string,
    code: BaselineLoaderErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'BaselineLoader', details, cause);
    this.name = 'BaselineLoaderError';
  }
}

/**
 * Codes d'erreur pour BaselineService (héritage de baseline.ts)
 */
export enum BaselineServiceErrorCode {
  BASELINE_NOT_FOUND = 'BASELINE_NOT_FOUND',
  BASELINE_INVALID = 'BASELINE_INVALID',
  COMPARISON_FAILED = 'COMPARISON_FAILED',
  DECISION_NOT_FOUND = 'DECISION_NOT_FOUND',
  DECISION_INVALID_STATUS = 'DECISION_INVALID_STATUS',
  APPLICATION_FAILED = 'APPLICATION_FAILED',
  INVENTORY_COLLECTION_FAILED = 'INVENTORY_COLLECTION_FAILED',
  ROADMAP_UPDATE_FAILED = 'ROADMAP_UPDATE_FAILED'
}

/**
 * Erreur spécifique pour BaselineService
 */
export class BaselineServiceError extends StateManagerError {
  constructor(
    message: string,
    code: BaselineServiceErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'BaselineService', details, cause);
    this.name = 'BaselineServiceError';
  }
}

/**
 * Codes d'erreur génériques
 */
export enum GenericErrorCode {
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  FILE_SYSTEM_ERROR = 'FILE_SYSTEM_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  TIMEOUT = 'TIMEOUT',
  INVALID_ARGUMENT = 'INVALID_ARGUMENT'
}

/**
 * Erreur générique
 */
export class GenericError extends StateManagerError {
  constructor(
    message: string,
    code: GenericErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'Generic', details, cause);
    this.name = 'GenericError';
  }
}

/**
 * Fonction utilitaire pour créer une erreur StateManagerError
 * à partir d'une erreur JavaScript standard
 */
export function createErrorFromStandardError(
  error: unknown,
  defaultCode: string,
  service: string,
  defaultMessage?: string
): StateManagerError {
  if (error instanceof StateManagerError) {
    return error;
  }

  if (error instanceof Error) {
    return new StateManagerError(
      defaultMessage || error.message,
      defaultCode,
      service,
      { originalError: error.name },
      error
    );
  }

  return new StateManagerError(
    defaultMessage || String(error),
    defaultCode,
    service,
    { originalValue: error }
  );
}

/**
 * Fonction utilitaire pour vérifier si une erreur est d'un type spécifique
 */
export function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof StateManagerError && error.code === code;
}

/**
 * Fonction utilitaire pour vérifier si une erreur est d'un service spécifique
 */
export function isServiceError(error: unknown, service: string): boolean {
  return error instanceof StateManagerError && error.service === service;
}

// =============================================================================
// NOUVEAUX CODES D'ERREUR (T2.8 - Amélioration gestion des erreurs)
// =============================================================================

/**
 * Codes d'erreur pour SynthesisService
 */
export enum SynthesisServiceErrorCode {
  NOT_IMPLEMENTED = 'SYNTHESIS_NOT_IMPLEMENTED',
  LLM_MODEL_REQUIRED = 'LLM_MODEL_REQUIRED',
  MAX_CONCURRENCY_INVALID = 'MAX_CONCURRENCY_INVALID',
  TASK_FILTER_INVALID = 'TASK_FILTER_INVALID',
  TASK_ID_REQUIRED = 'TASK_ID_REQUIRED',
  MAX_DEPTH_INVALID = 'MAX_DEPTH_INVALID',
  MAX_CONTEXT_SIZE_INVALID = 'MAX_CONTEXT_SIZE_INVALID',
  NO_ANALYSIS_TO_CONDENSE = 'NO_ANALYSIS_TO_CONDENSE',
  NO_MODEL_CONFIGURED = 'NO_MODEL_CONFIGURED',
  DEFAULT_MODEL_REQUIRED = 'DEFAULT_MODEL_REQUIRED',
  BATCH_SYNTHESIS_FAILED = 'BATCH_SYNTHESIS_FAILED',
  SYNTHESIS_GENERATION_FAILED = 'SYNTHESIS_GENERATION_FAILED',
  CONDENSATION_FAILED = 'CONDENSATION_FAILED'
}

/**
 * Erreur spécifique pour SynthesisService
 */
export class SynthesisServiceError extends StateManagerError {
  constructor(
    message: string,
    code: SynthesisServiceErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'SynthesisService', details, cause);
    this.name = 'SynthesisServiceError';
  }
}

/**
 * Codes d'erreur pour TraceSummaryService
 */
export enum TraceSummaryServiceErrorCode {
  ROOT_TASK_REQUIRED = 'ROOT_TASK_REQUIRED',
  CHILD_TASKS_INVALID = 'CHILD_TASKS_INVALID',
  SUMMARY_GENERATION_FAILED = 'SUMMARY_GENERATION_FAILED',
  EXPORT_FAILED = 'EXPORT_FAILED'
}

/**
 * Erreur spécifique pour TraceSummaryService
 */
export class TraceSummaryServiceError extends StateManagerError {
  constructor(
    message: string,
    code: TraceSummaryServiceErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'TraceSummaryService', details, cause);
    this.name = 'TraceSummaryServiceError';
  }
}

/**
 * Codes d'erreur pour PowerShellExecutor
 */
export enum PowerShellExecutorErrorCode {
  NO_JSON_FOUND = 'NO_JSON_FOUND',
  EXECUTION_FAILED = 'EXECUTION_FAILED',
  TIMEOUT = 'TIMEOUT',
  SCRIPT_NOT_FOUND = 'SCRIPT_NOT_FOUND',
  PARSE_FAILED = 'PARSE_FAILED',
  CONFIG_MISSING = 'CONFIG_MISSING'
}

/**
 * Erreur spécifique pour PowerShellExecutor
 */
export class PowerShellExecutorError extends StateManagerError {
  constructor(
    message: string,
    code: PowerShellExecutorErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'PowerShellExecutor', details, cause);
    this.name = 'PowerShellExecutorError';
  }
}

/**
 * Codes d'erreur pour MessageManager (RooSync)
 */
export enum MessageManagerErrorCode {
  MESSAGE_NOT_FOUND = 'MESSAGE_NOT_FOUND',
  MESSAGE_SEND_FAILED = 'MESSAGE_SEND_FAILED',
  MESSAGE_READ_FAILED = 'MESSAGE_READ_FAILED',
  INBOX_READ_FAILED = 'INBOX_READ_FAILED',
  ARCHIVE_FAILED = 'ARCHIVE_FAILED',
  INVALID_RECIPIENT = 'INVALID_RECIPIENT',
  INVALID_MESSAGE_FORMAT = 'INVALID_MESSAGE_FORMAT'
}

/**
 * Erreur spécifique pour MessageManager
 */
export class MessageManagerError extends StateManagerError {
  constructor(
    message: string,
    code: MessageManagerErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'MessageManager', details, cause);
    this.name = 'MessageManagerError';
  }
}

/**
 * Codes d'erreur pour CacheManager
 */
export enum CacheManagerErrorCode {
  CACHE_READ_FAILED = 'CACHE_READ_FAILED',
  CACHE_WRITE_FAILED = 'CACHE_WRITE_FAILED',
  CACHE_INVALIDATION_FAILED = 'CACHE_INVALIDATION_FAILED',
  CACHE_PERSISTENCE_FAILED = 'CACHE_PERSISTENCE_FAILED',
  CACHE_ENTRY_EXPIRED = 'CACHE_ENTRY_EXPIRED'
}

/**
 * Erreur spécifique pour CacheManager
 */
export class CacheManagerError extends StateManagerError {
  constructor(
    message: string,
    code: CacheManagerErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'CacheManager', details, cause);
    this.name = 'CacheManagerError';
  }
}

/**
 * Codes d'erreur pour InventoryCollector
 */
export enum InventoryCollectorErrorCode {
  SCRIPT_NOT_FOUND = 'SCRIPT_NOT_FOUND',
  SCRIPT_EXECUTION_FAILED = 'SCRIPT_EXECUTION_FAILED',
  INVENTORY_PARSE_FAILED = 'INVENTORY_PARSE_FAILED',
  INVENTORY_SAVE_FAILED = 'INVENTORY_SAVE_FAILED',
  REMOTE_MACHINE_NOT_FOUND = 'REMOTE_MACHINE_NOT_FOUND',
  SHARED_STATE_NOT_ACCESSIBLE = 'SHARED_STATE_NOT_ACCESSIBLE'
}

/**
 * Erreur spécifique pour InventoryCollector
 */
export class InventoryCollectorError extends StateManagerError {
  constructor(
    message: string,
    code: InventoryCollectorErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'InventoryCollector', details, cause);
    this.name = 'InventoryCollectorError';
  }
}

/**
 * Codes d'erreur pour RooStorageDetector
 */
export enum RooStorageDetectorErrorCode {
  NO_STORAGE_FOUND = 'NO_STORAGE_FOUND',
  DETECTION_FAILED = 'DETECTION_FAILED',
  INVALID_PATH = 'INVALID_PATH'
}

/**
 * Erreur spécifique pour RooStorageDetector
 */
export class RooStorageDetectorError extends StateManagerError {
  constructor(
    message: string,
    code: RooStorageDetectorErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'RooStorageDetector', details, cause);
    this.name = 'RooStorageDetectorError';
  }
}

/**
 * Codes d'erreur pour ExportConfigManager
 */
export enum ExportConfigManagerErrorCode {
  CONFIG_PATH_NOT_FOUND = 'CONFIG_PATH_NOT_FOUND',
  CONFIG_LOAD_FAILED = 'CONFIG_LOAD_FAILED',
  CONFIG_SAVE_FAILED = 'CONFIG_SAVE_FAILED',
  NO_STORAGE_DETECTED = 'NO_STORAGE_DETECTED'
}

/**
 * Erreur spécifique pour ExportConfigManager
 */
export class ExportConfigManagerError extends StateManagerError {
  constructor(
    message: string,
    code: ExportConfigManagerErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'ExportConfigManager', details, cause);
    this.name = 'ExportConfigManagerError';
  }
}

/**
 /**
  * Codes d'erreur pour ConfigSharingService
  */
 export enum ConfigSharingServiceErrorCode {
   INVENTORY_INCOMPLETE = 'INVENTORY_INCOMPLETE',
   COLLECTION_FAILED = 'COLLECTION_FAILED',
   PATH_NOT_AVAILABLE = 'PATH_NOT_AVAILABLE',
   PUBLISH_FAILED = 'PUBLISH_FAILED',
   INVALID_TARGET_FORMAT = 'INVALID_TARGET_FORMAT'
 }
/**
 * Erreur spécifique pour ConfigSharingService
 */
export class ConfigSharingServiceError extends StateManagerError {
  constructor(
    message: string,
    code: ConfigSharingServiceErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'ConfigSharingService', details, cause);
    this.name = 'ConfigSharingServiceError';
  }
}

// =============================================================================
// T3.7 - Fonctions de classification d'erreur (Script vs Système)
// =============================================================================

/**
 * Indicateurs d'erreur script PowerShell
 * Patterns typiques de bugs dans le code PowerShell lui-même
 */
const SCRIPT_ERROR_PATTERNS = [
  /syntax error/i,
  /unexpected token/i,
  /unexpected '\{/i,
  /unexpected '\('/i,
  /missing '\}'/i,
  /missing '\)'/i,
  /missing closing/i,
  /invalid syntax/i,
  /variable .* cannot be retrieved/i,
  /term '.*' is not recognized/i,
  /the term '.*' is not recognized as a cmdlet/i,
  /command .* not found/i,
  /invalid operation/i,
  /cannot convert value/i,
  /cannot index into a null array/i,
  /you cannot call a method on a null-valued expression/i,
  /object reference not set to an instance/i,
  /null-valued expression/i,
  /method invocation is not supported/i,
  /property assignment is not supported/i,
  /the property '.*' cannot be found on this object/i,
  /cannot validate argument on parameter/i,
  /parameter name '.*' is ambiguous/i,
  /a parameter cannot be found that matches parameter name/i
];

/**
 * Indicateurs d'erreur système PowerShell
 * Problèmes d'exécution indépendants du code
 */
const SYSTEM_ERROR_PATTERNS = [
  /cannot find path/i,
  /path .* not found/i,
  /file not found/i,
  /no such file or directory/i,
  /access (denied|to the path|is denied|denied to)/i,
  /permission denied/i,
  /unauthorized access/i,
  /timeout/i,
  /timed out/i,
  /operation timed out/i,
  /network path not found/i,
  /network unreachable/i,
  /connection refused/i,
  /no connection could be made/i,
  /the network path was not found/i,
  /the remote server returned an error/i,
  /disk full/i,
  /not enough disk space/i,
  /write error/i,
  /read error/i,
  /i\/o error/i,
  /device not ready/i,
  /drive not ready/i,
  /the process cannot access the file/i,
  /being used by another process/i,
  /locked/i
];

/**
 * Interface pour les résultats d'exécution PowerShell
 */
export interface PowerShellExecutionResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
}

/**
 * Détecte si une erreur PowerShell est de type script ou système
 *
 * @param error - Le résultat d'exécution PowerShell ou une erreur
 * @returns La catégorie d'erreur (SCRIPT, SYSTEM ou UNKNOWN)
 *
 * @example
 * ```typescript
 * const result = await executor.execute(script);
 * if (result.exitCode !== 0) {
 *   const category = detectPowerShellErrorType(result);
 *   throw new PowerShellExecutorError(
 *     'Script failed',
 *     'EXECUTION_FAILED',
 *     { category }
 *   );
 * }
 * ```
 */
export function detectPowerShellErrorType(
  error: PowerShellExecutionResult | Error | string
): ErrorCategory {
  // Extraire le texte d'erreur
  let errorText = '';

  if (typeof error === 'string') {
    errorText = error;
  } else if (error instanceof Error) {
    errorText = error.message;
  } else if (error.stderr) {
    errorText = error.stderr;
  } else if (error.stdout) {
    errorText = error.stdout;
  } else if (error.error?.message) {
    errorText = error.error.message;
  }

  if (!errorText) {
    return ErrorCategory.UNKNOWN;
  }

  const lowerText = errorText.toLowerCase();

  // Vérifier les indicateurs d'erreur script en premier
  for (const pattern of SCRIPT_ERROR_PATTERNS) {
    if (pattern.test(lowerText)) {
      return ErrorCategory.SCRIPT;
    }
  }

  // Vérifier les indicateurs d'erreur système
  for (const pattern of SYSTEM_ERROR_PATTERNS) {
    if (pattern.test(lowerText)) {
      return ErrorCategory.SYSTEM;
    }
  }

  // Si aucun pattern n'est reconnu, retourner UNKNOWN
  return ErrorCategory.UNKNOWN;
}

/**
 * Détermine la catégorie d'erreur basée sur le code d'erreur
 * Pour les services qui ont des codes d'erreur connus
 *
 * @param service - Le nom du service
 * @param code - Le code d'erreur
 * @returns La catégorie d'erreur suggérée
 */
export function suggestErrorCategory(service: string, code: string): ErrorCategory {
  // Mapping des codes d'erreur connus vers les catégories
  const scriptErrorCodes = new Set([
    'INVENTORY_PARSE_FAILED',
    'PARSE_FAILED',
    'INVALID_ARGUMENT',
    'VALIDATION_FAILED',
    'IDENTITY_CONFLICT',
    'BASELINE_INVALID'
  ]);

  const systemErrorCodes = new Set([
    'SCRIPT_NOT_FOUND',
    'SCRIPT_EXECUTION_FAILED',
    'INVENTORY_SAVE_FAILED',
    'REMOTE_MACHINE_NOT_FOUND',
    'SHARED_STATE_NOT_ACCESSIBLE',
    'FILE_SYSTEM_ERROR',
    'NETWORK_ERROR',
    'PERMISSION_DENIED',
    'TIMEOUT',
    'NO_JSON_FOUND',
    'EXECUTION_FAILED'
  ]);

  if (scriptErrorCodes.has(code)) {
    return ErrorCategory.SCRIPT;
  }

  if (systemErrorCodes.has(code)) {
    return ErrorCategory.SYSTEM;
  }

  return ErrorCategory.UNKNOWN;
}
