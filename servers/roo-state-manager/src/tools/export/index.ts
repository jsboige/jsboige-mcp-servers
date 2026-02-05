/**
 * Exports pour les outils d'export (XML, JSON, CSV)
 *
 * CONS-10: Consolidation 6→2 outils
 * - export_data: Remplace les 5 outils d'export (task/conversation/project × xml/json/csv)
 * - export_config: Remplace configure_xml_export
 */

// ============================================================
// CONS-10: Nouveaux outils consolidés
// ============================================================
export { exportDataTool, handleExportData } from './export-data.js';
export type { ExportDataArgs, ExportTarget, ExportFormat } from './export-data.js';

export { exportConfigTool, handleExportConfig } from './export-config.js';
export type { ExportConfigArgs, ExportConfigAction } from './export-config.js';

// ============================================================
// [DEPRECATED] Anciens outils - Conservés pour backward compatibility
// À retirer dans une version future
// ============================================================

// XML Export tools [DEPRECATED - use export_data with format='xml']
export { exportTasksXmlTool, handleExportTasksXml } from './export-tasks-xml.js';
export { exportConversationXmlTool, handleExportConversationXml } from './export-conversation-xml.js';
export { exportProjectXmlTool, handleExportProjectXml } from './export-project-xml.js';

// Config tool [DEPRECATED - use export_config]
export { configureXmlExportTool, handleConfigureXmlExport } from './configure-xml-export.js';

// JSON & CSV Export tools [DEPRECATED - use export_data with format='json'/'csv']
export { exportConversationJsonTool, handleExportConversationJson } from './export-conversation-json.js';
export { exportConversationCsvTool, handleExportConversationCsv } from './export-conversation-csv.js';