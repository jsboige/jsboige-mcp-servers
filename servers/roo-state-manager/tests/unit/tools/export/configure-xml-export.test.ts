import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleConfigureXmlExport } from '../../../../src/tools/export/configure-xml-export';
import { ExportConfigManager } from '../../../../src/services/ExportConfigManager';

describe('configure-xml-export.tool', () => {
  let mockExportConfigManager: any;

  beforeEach(() => {
    // Mock du service
    mockExportConfigManager = {
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
      resetConfig: vi.fn(),
      validateConfiguration: vi.fn(),
    };
  });

  it('devrait récupérer la configuration actuelle', async () => {
    const mockConfig = {
      prettyPrint: true,
      includeMetadata: true,
      encoding: 'utf8'
    };

    mockExportConfigManager.getConfig.mockResolvedValue(mockConfig);

    const result = await handleConfigureXmlExport({
      action: 'get'
    }, mockExportConfigManager);

    expect(mockExportConfigManager.getConfig).toHaveBeenCalled();
    expect(result.content[0].text).toContain('prettyPrint');
    expect(result.content[0].text).toContain('true');
  });

  it('devrait mettre à jour la configuration', async () => {
    const newConfig = {
      prettyPrint: false
    };

    mockExportConfigManager.updateConfig.mockResolvedValue(undefined);

    const result = await handleConfigureXmlExport({
      action: 'set',
      config: newConfig
    }, mockExportConfigManager);

    expect(mockExportConfigManager.updateConfig).toHaveBeenCalledWith(newConfig);
    expect(result.content[0].text).toContain('Configuration mise à jour avec succès');
  });

  it('devrait réinitialiser la configuration', async () => {
    mockExportConfigManager.resetConfig.mockResolvedValue(undefined);

    const result = await handleConfigureXmlExport({
      action: 'reset'
    }, mockExportConfigManager);

    expect(mockExportConfigManager.resetConfig).toHaveBeenCalled();
    expect(result.content[0].text).toContain('Configuration remise aux valeurs par défaut');
  });

  it('devrait gérer les erreurs', async () => {
    const error = new Error('Test error');
    mockExportConfigManager.getConfig.mockRejectedValue(error);

    const result = await handleConfigureXmlExport({
      action: 'get'
    }, mockExportConfigManager);

    expect(result.content[0].text).toContain('Erreur lors de la configuration');
    expect(result.content[0].text).toContain('Test error');
  });
});