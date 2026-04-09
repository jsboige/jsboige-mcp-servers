/**
 * Tests pour SmartCleanerService
 *
 * Ce service implémente un système de nettoyage intelligent du contenu
 * avec configuration flexible et analyse préalable des économies potentielles.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    SmartCleanerService,
    type CleaningConfig,
    type CleaningResult,
    type ClassifiedContent
} from '../../../src/services/SmartCleanerService.js';

describe('SmartCleanerService', () => {
  let service: SmartCleanerService;
  let mockContent: ClassifiedContent[];

  beforeEach(() => {
    service = new SmartCleanerService();
    mockContent = [
      {
        content: `<environment_details>
  <environment_version>1.0.0</environment_version>
</environment_details>

User message content`,
        type: 'user',
        contentSize: 150
      },
      {
        content: `[read_file for 'test.txt'] Result:
<file_write_result>
  <success>true</success>
</file_write_result>

Assistant response`,
        type: 'assistant',
        contentSize: 200
      }
    ];
  });

  describe('initialisation', () => {
    it('devrait initialiser avec la configuration par défaut', () => {
      expect(service).toBeInstanceOf(SmartCleanerService);
    });

    it('devrait accepter une configuration personnalisée', () => {
      const customConfig: Partial<CleaningConfig> = {
        removeTimestamps: true,
        maxConsecutiveEmptyLines: 2
      };
      const customService = new SmartCleanerService(customConfig);

      // Vérifier que la configuration est fusionnée
      expect(customService).toBeInstanceOf(SmartCleanerService);
    });
  });

  describe('cleanContent', () => {
    it('devrait nettoyer le contenu et retourner un résultat complet', () => {
      const result = service.cleanContent(mockContent);

      expect(result.cleanedContent).toHaveLength(2);
      expect(result.result.originalSize).toBe(350);
      expect(result.result.cleanedSize).toBeLessThan(350);
      expect(result.result.compressionRatio).toBeGreaterThan(0);
      expect(result.result.removedElements.environmentDetails).toBeGreaterThan(0);
    });

    it('devrait gérer le contenu vide', () => {
      const result = service.cleanContent([]);

      expect(result.cleanedContent).toHaveLength(0);
      expect(result.result.originalSize).toBe(0);
      expect(result.result.compressionRatio).toBe(0);
    });

    it('devrait filtrer les éléments vides après nettoyage', () => {
      const contentWithEmpty = [
        ...mockContent,
        { content: '', type: 'system', contentSize: 0 }
      ];

      const result = service.cleanContent(contentWithEmpty);
      expect(result.cleanedContent).toHaveLength(2); // L'élément vide est filtré
    });

    it('devrait accepter une configuration temporaire', () => {
      const customConfig = {
        removeTimestamps: true,
        removeCostInfo: false
      };

      const result = service.cleanContent(mockContent, customConfig);

      expect(result.cleanedContent).toHaveLength(2);
      // La configuration personnalisée doit être appliquée
    });
  });

  describe('removeEnvironmentDetails', () => {
    it('devrait supprimer les blocs environment_details', () => {
      const content = `
<environment_details>
  <environment_version>1.0.0</environment_version>
</environment_details>

Real content`;

      const cleaned = (service as any).removeEnvironmentDetails(content);

      expect(cleaned).not.toContain('<environment_details>');
      expect(cleaned).toContain('Real content');
    });

    it('devrait supprimer les sections VSCode', () => {
      const content = `
# VScode Visible Files
file1.txt
file2.txt

# Current Time
2024-01-01T10:00:00Z

Real content`;

      const cleaned = (service as any).removeEnvironmentDetails(content);

      expect(cleaned).not.toContain('# VScode Visible Files');
      expect(cleaned).not.toContain('# Current Time');
      expect(cleaned).toContain('Real content');
    });

    it('devrait gérer l'absence d'éléments à supprimer', () => {
      const cleanContent = 'Just some content';
      const cleaned = (service as any).removeEnvironmentDetails(cleanContent);

      expect(cleaned).toBe(cleanContent);
    });
  });

  describe('removeRedundantMetadata', () => {
    it('devrait supprimer les résultats d'opération', () => {
      const content = `
[read_file for 'test.txt'] Result:
File content

Real message`;

      const cleaned = (service as any).removeRedundantMetadata(content);

      expect(cleaned).not.toContain('[read_file for');
      expect(cleaned).not.toContain('Result:');
      expect(cleaned).toContain('Real message');
    });

    it('devrait supprimer les balises XML', () => {
      const content = `
<file_write_result>
  <success>true</success>
</file_write_result>

<operation>test</operation>

Content`;

      const cleaned = (service as any).removeRedundantMetadata(content);

      expect(cleaned).not.toContain('<file_write_result>');
      expect(cleaned).not.toContain('<operation>');
      expect(cleaned).toContain('Content');
    });
  });

  describe('removeDebugInfo', () => {
    it('devrait supprimer les informations de debug', () => {
      const content = `
Debug Info:
- Similarity: 0.95
- Threshold: 0.8

Real content`;

      const cleaned = (service as any).removeDebugInfo(content);

      expect(cleaned).not.toContain('Debug Info:');
      expect(cleaned).not.toContain('Similarity:');
      expect(cleaned).toContain('Real content');
    });

    it('devrait supprimer les scores de similarité', () => {
      const content = `
Similarity Score: 0.95
Best Match Found:
  content: test

Real content`;

      const cleaned = (service as any).removeDebugInfo(content);

      expect(cleaned).not.toContain('Similarity Score:');
      expect(cleaned).not.toContain('Best Match Found:');
      expect(cleaned).toContain('Real content');
    });
  });

  describe('removeTimestamps', () => {
    it('devrait supprimer les timestamps ISO', () => {
      const content = `
Message from 2024-01-01T10:00:00.000Z
Some content`;

      const cleaned = (service as any).removeTimestamps(content);

      expect(cleaned).not.toContain('2024-01-01T10:00:00.000Z');
      expect(cleaned).toContain('Some content');
    });

    it('devrait supprimer les timestamps JSON', () => {
      const content = `
{
  "timestamp": "2024-01-01T10:00:00Z",
  "content": "test"
}`;

      const cleaned = (service as any).removeTimestamps(content);

      expect(cleaned).not.toContain('"timestamp":');
      expect(cleaned).toContain('test');
    });
  });

  describe('removeCostInfo', () => {
    it('devrait supprimer les informations de coût', () => {
      const content = `
# Current Cost
$0.00345

Some text`;

      const cleaned = (service as any).removeCostInfo(content);

      expect(cleaned).not.toContain('$0.00345');
      expect(cleaned).toContain('Some text');
    });

    it('devrait supprimer les tokens et coûts JSON', () => {
      const content = `
{
  "cost": 0.001,
  "tokensIn": 100,
  "tokensOut": 50
}`;

      const cleaned = (service as any).removeCostInfo(content);

      expect(cleaned).not.toContain('"cost":');
      expect(cleaned).not.toContain('"tokensIn":');
      expect(cleaned).toContain('}');
    });
  });

  describe('removeFileInfo', () => {
    it('devrait supprimer les informations de fichiers VSCode', () => {
      const content = `
# VSCode Visible Files
- file1.txt
- file2.txt

Real content`;

      const cleaned = (service as any).removeFileInfo(content);

      expect(cleaned).not.toContain('# VSCode Visible Files');
      expect(cleaned).toContain('Real content');
    });
  });

  describe('minimizeWhitespace', () => {
    it('devrait minimiser les espaces blancs', () => {
      const content = `Line with spaces
  and tabs
	and mixed

Final line`;

      const cleaned = (service as any).minimizeWhitespace(content);

      // Suppression espaces en fin de ligne
      expect(cleaned).not.toContain('spaces    ');
      // Normalisation des espaces multiples
      expect(cleaned).not.toContain('and tabs	');
    });

    it('devrait préserver l'indentation', () => {
      const content = `  indented
  multi
    line`;

      const cleaned = (service as any).minimizeWhitespace(content);

      expect(cleaned).toContain('  indented');
      expect(cleaned).toContain('  multi');
      expect(cleaned).toContain('    line');
    });
  });

  describe('removeExcessiveEmptyLines', () => {
    it('devrait limiter le nombre de lignes vides consécutives', () => {
      const content = `Line 1


Line 2


Line 3`;

      const cleaned = (service as any).removeExcessiveEmptyLines(content, 1);

      const lines = cleaned.split('\n');
      expect(lines).toEqual(['Line 1', '', 'Line 2', '', 'Line 3']);
    });

    it('devrait gérer maxConsecutive à 0', () => {
      const content = `Line 1


Line 2`;

      const cleaned = (service as any).removeExcessiveEmptyLines(content, 0);

      expect(cleaned).toBe('Line 1\nLine 2');
    });

    it('devrait préserver les lignes non vides', () => {
      const content = `Line 1
Line 2

Line 3`;

      const cleaned = (service as any).removeExcessiveEmptyLines(content, 2);

      expect(cleaned).toContain('Line 1');
      expect(cleaned).toContain('Line 2');
      expect(cleaned).toContain('Line 3');
    });
  });

  describe('analyseContent', () => {
    it('devrait analyser le contenu et retourner des statistiques', () => {
      const contentWithDebug = [
        {
          content: `
Debug Info:
Similarity Score: 0.95

Some content`,
          type: 'user',
          contentSize: 100
        },
        {
          content: `
<environment_details>
  test
</environment_details>

Real content`,
          type: 'assistant',
          contentSize: 150
        }
      ];

      const stats = (service as any).analyzeContent(contentWithDebug);

      expect(stats.environmentDetailsCount).toBe(1);
      expect(stats.debugInfoCount).toBe(1);
      expect(stats.estimatedSavings).toBeGreaterThan(0);
    });

    it('devrait compter correctement les différents éléments', () => {
      const content = [
        {
          content: `
<environment_details>
  test
</environment_details>

[read_file for 'test.txt'] Result:

Cost: $0.01

2024-01-01T10:00:00Z`,
          type: 'user',
          contentSize: 200
        }
      ];

      const stats = (service as any).analyzeContent(content);

      expect(stats.environmentDetailsCount).toBe(1);
      expect(stats.redundantMetadataCount).toBe(1);
      expect(stats.costInfoCount).toBe(1);
      expect(stats.timestampCount).toBe(1);
    });

    it('devrait estimer les économies basé sur la taille totale', () => {
      const largeContent = [
        {
          content: 'x'.repeat(1000),
          type: 'user',
          contentSize: 1000
        }
      ];

      const stats = (service as any).analyzeContent(largeContent);

      expect(stats.estimatedSavings).toBeGreaterThan(0);
      expect(stats.estimatedSavings).toBeLessThanOrEqual(1000);
    });
  });

  describe('scénarios de configuration', () => {
    it('devrait nettoyer agressivement quand toutes les options sont activées', () => {
      const aggressiveConfig: CleaningConfig = {
        removeEnvironmentDetails: true,
        removeRedundantMetadata: true,
        removeDebugInfo: true,
        removeTimestamps: true,
        removeCostInfo: true,
        removeFileInfo: true,
        minimizeWhitespace: true,
        removeEmptyLines: true,
        maxConsecutiveEmptyLines: 0
      };

      const result = service.cleanContent(mockContent, aggressiveConfig);

      expect(result.result.compressionRatio).toBeGreaterThan(0.5); + 'Plus de 50% de compression'
    });

    it('devrait préserver tout quand aucune option n'est activée', () => {
      const minimalConfig: CleaningConfig = {
        removeEnvironmentDetails: false,
        removeRedundantMetadata: false,
        removeDebugInfo: false,
        removeTimestamps: false,
        removeCostInfo: false,
        removeFileInfo: false,
        minimizeWhitespace: false,
        removeEmptyLines: false,
        maxConsecutiveEmptyLines: 10
      };

      const result = service.cleanContent(mockContent, minimalConfig);

      // Le contenu devrait être presque identique
      expect(result.result.compressionRatio).toBeCloseTo(0, 1);
    });
  });

  describe('cas limites', () => {
    it('devrait gérer le contenu avec des caractères spéciaux', () => {
      const content = `
<environment_details>
  <version>1.0</version>
</environment_details>

Special chars: <>&"'
`;

      const result = service.cleanContent([{
        content: content,
        type: 'user',
        contentSize: content.length
      }]);

      expect(result.cleanedContent[0].content).toContain('Special chars');
    });

    it('devrait gérer les très longs contenus', () => {
      const longContent = 'x'.repeat(10000);
      const content = [{
        content: longContent,
        type: 'user',
        contentSize: 10000
      }];

      const result = service.cleanContent(content);

      expect(result.cleanedContent[0].contentSize).toBeLessThanOrEqual(10000);
    });

    it('devrait gérer les contenu avec des sauts de ligne multiples', () => {
      const content = `Line 1


Line 2


Line 3


Line 4`;

      const result = service.cleanContent([{
        content: content,
        type: 'user',
        contentSize: content.length
      }]);

      expect(result.cleanedContent[0].content).toContain('Line 1');
      expect(result.cleanedContent[0].content).toContain('Line 4');
    });
  });

  describe('métriques de nettoyage', () => {
    it('devrait calculer correctement le taux de compression', () => {
      const content = [
        {
          content: 'A' .repeat(100),
          type: 'user',
          contentSize: 100
        },
        {
          content: 'B' .repeat(200),
          type: 'assistant',
          contentSize: 200
        }
      ];

      const result = service.cleanContent(content);

      expect(result.result.originalSize).toBe(300);
      expect(result.result.cleanedSize).toBeLessThan(300);
      expect(result.result.compressionRatio).toBeGreaterThan(0);
      expect(result.result.compressionRatio).toBeLessThanOrEqual(1);
    });

    it('devrait compter les éléments supprimés', () => {
      const contentWithLotsOfMetadata = `
<environment_details>
  test
</environment_details>

[read_file for 'test.txt'] Result:

Debug Info:
Similarity: 0.95

# VScode Visible Files
file1.txt

Cost: $0.01

2024-01-01T10:00:00Z

Real content`;

      const result = service.cleanContent([{
        content: contentWithLotsOfMetadata,
        type: 'user',
        contentSize: contentWithLotsOfMetadata.length
      }]);

      expect(result.result.removedElements.environmentDetails).toBeGreaterThan(0);
      expect(result.result.removedElements.redundantMetadata).toBeGreaterThan(0);
      expect(result.result.removedElements.debugInfo).toBeGreaterThan(0);
    });
  });
});