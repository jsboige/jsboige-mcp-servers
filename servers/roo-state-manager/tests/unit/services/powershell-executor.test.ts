/**
 * Tests unitaires pour PowerShellExecutor
 *
 * @module tests/unit/services/powershell-executor.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PowerShellExecutor, resetDefaultExecutor, getDefaultExecutor } from '../../../src/services/PowerShellExecutor.js';
import { join } from 'path';

// Mock des modules fs et path pour les tests
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn()
}));

vi.mock('path', () => ({
  default: {
    join: vi.fn((...paths: string[]) => paths.join('/')),
    normalize: vi.fn((path: string) => path),
    resolve: vi.fn((...paths: string[]) => paths.join('/')),
    dirname: vi.fn((path: string) => path.split('/').slice(0, -1).join('/')),
    basename: vi.fn((path: string) => path.split('/').pop()),
    extname: vi.fn((path: string) => path.split('.').pop() ? '.' + path.split('.').pop() : ''),
    relative: vi.fn((from: string, to: string) => to.replace(from + '/', ''))
  },
  join: vi.fn((...paths: string[]) => paths.join('/')),
  normalize: vi.fn((path: string) => path),
  resolve: vi.fn((...paths: string[]) => paths.join('/')),
  dirname: vi.fn((path: string) => path.split('/').slice(0, -1).join('/')),
  basename: vi.fn((path: string) => path.split('/').pop()),
  extname: vi.fn((path: string) => path.split('.').pop() ? '.' + path.split('.').pop() : ''),
  relative: vi.fn((from: string, to: string) => to.replace(from + '/', ''))
}));

// Variables globales pour contrôler le comportement du mock
let mockExitCode = 0;
let mockStdout = 'Hello from PowerShell';
let mockStderr = '';
let mockShouldTimeout = false;
let mockDelay = 10;
let mockFiles: Record<string, string> = {};
let testDir = '';

// Mock du module child_process pour éviter les vraies exécutions PowerShell
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const mockProcess = {
      stdout: {
        on: vi.fn((event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') {
            // Simuler la sortie PowerShell
            setTimeout(() => callback(Buffer.from(mockStdout, 'utf-8')), mockDelay);
          }
        })
      },
      stderr: {
        on: vi.fn((event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') {
            // Simuler les erreurs PowerShell
            const errorMessage = mockShouldTimeout ? 'timed out' : mockStderr;
            setTimeout(() => callback(Buffer.from(errorMessage, 'utf-8')), mockDelay);
          }
        })
      },
      on: vi.fn((event: string, callback: (code: number | null) => void) => {
        if (event === 'close') {
          if (mockShouldTimeout) {
            // Simuler un timeout après un délai
            setTimeout(() => callback(null), mockDelay * 5);
            return;
          }
          // Simuler le code de sortie
          setTimeout(() => callback(mockExitCode), mockDelay * 2);
        }
      }),
      kill: vi.fn(),
      killed: false
    };
    
    // Simuler le kill pour le timeout
    setTimeout(() => {
      if (mockShouldTimeout) {
        mockProcess.killed = true;
      }
    }, mockDelay * 3);
    
    return mockProcess;
  })
}));

// Mock du module fs pour intercepter le require dynamique dans PowerShellExecutor
const originalRequire = require;
const mockedRequire = vi.fn((id: string) => {
  if (id === 'fs') {
    return {
      existsSync: vi.fn((path: string) => {
        console.log(`Mock existsSync called with: ${path}`);
        console.log(`mockFiles keys: ${Object.keys(mockFiles)}`);
        console.log(`testDir: ${testDir}`);
        const result = mockFiles[path] !== undefined || path === testDir;
        console.log(`existsSync result: ${result}`);
        return result;
      }),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((path: string, content: string) => {
        console.log(`Mock writeFileSync called with: ${path}`);
        mockFiles[path] = content;
      }),
      rmSync: vi.fn(() => {
        mockFiles = {};
      }),
      readFileSync: vi.fn(),
      readdirSync: vi.fn(),
      statSync: vi.fn()
    };
  }
  return originalRequire(id);
});

// Remplacer le require global avec stubGlobal
vi.stubGlobal('require', mockedRequire);

// Fonctions utilitaires pour contrôler le mock
function setMockBehavior(options: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  shouldTimeout?: boolean;
  delay?: number;
}) {
  mockExitCode = options.exitCode ?? 0;
  mockStdout = options.stdout ?? 'Hello from PowerShell';
  mockStderr = options.stderr ?? '';
  mockShouldTimeout = options.shouldTimeout ?? false;
  mockDelay = options.delay ?? 10;
}

// Import des modules mockés
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import * as path from 'path';

describe('PowerShellExecutor', () => {
  let executor: PowerShellExecutor;
  let testDir: string;
  let mockFiles: Record<string, string> = {};

  beforeEach(() => {
    // Réinitialiser les mocks
    vi.clearAllMocks();
    mockFiles = {};
    testDir = 'test-temp-powershell';
    
    // Mock des fonctions fs
    (existsSync as any).mockImplementation((path: string) => {
      return mockFiles[path] !== undefined || path === testDir;
    });
    
    (mkdirSync as any).mockImplementation(() => {
      // Simuler la création de répertoire
    });
    
    (writeFileSync as any).mockImplementation((path: string, content: string) => {
      mockFiles[path] = content;
    });
    
    (rmSync as any).mockImplementation(() => {
      // Simuler la suppression
      mockFiles = {};
    });
    
    // Mock des fonctions path
    (join as any).mockImplementation((...paths: string[]) => {
      return paths.filter(p => p).join('/');
    });

    // Initialiser l'executor avec le répertoire de test
    executor = new PowerShellExecutor({
      roosyncBasePath: testDir,
      defaultTimeout: 10000 // 10s pour les tests
    });

    // Réinitialiser l'instance par défaut
    resetDefaultExecutor();
  });

  afterEach(() => {
    // Nettoyer les mocks
    vi.restoreAllMocks();
  });

  describe('executeScript', () => {
    it('devrait exécuter une commande PowerShell simple', async () => {
      // Configurer le mock pour ce test
      setMockBehavior({
        exitCode: 0,
        stdout: 'Hello from PowerShell',
        stderr: ''
      });

      // Créer un script de test simple
      const scriptPath = 'test-echo.ps1';
      const scriptContent = 'Write-Output "Hello from PowerShell"';
      writeFileSync(join(testDir, scriptPath), scriptContent, 'utf-8');

      const result = await executor.executeScript(scriptPath, []);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Hello from PowerShell');
      expect(result.executionTime).toBeGreaterThan(0);
    });

    it('devrait gérer les arguments du script', async () => {
      // Configurer le mock pour ce test
      setMockBehavior({
        exitCode: 0,
        stdout: 'Name: Alice, Age: 30',
        stderr: ''
      });

      // Script qui utilise des paramètres
      const scriptPath = 'test-params.ps1';
      const scriptContent = `
        param([string]$Name, [int]$Age)
        Write-Output "Name: $Name, Age: $Age"
      `;
      writeFileSync(join(testDir, scriptPath), scriptContent, 'utf-8');

      const result = await executor.executeScript(
        scriptPath,
        ['-Name', 'Alice', '-Age', '30']
      );

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Name: Alice, Age: 30');
    });

    it('devrait détecter les erreurs PowerShell', async () => {
      // Configurer le mock pour ce test
      setMockBehavior({
        exitCode: 1,
        stdout: '',
        stderr: 'This is an error'
      });

      // Script qui génère une erreur
      const scriptPath = 'test-error.ps1';
      const scriptContent = `
        Write-Error "This is an error"
        exit 1
      `;
      // Ajouter le fichier au mock au lieu d'utiliser writeFileSync
      mockFiles[join(testDir, scriptPath)] = scriptContent;

      const result = await executor.executeScript(scriptPath, []);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('This is an error');
    });

    it('devrait gérer le timeout', async () => {
      // Configurer le mock pour simuler un timeout
      setMockBehavior({
        shouldTimeout: true,
        stdout: '',
        stderr: ''
      });

      // Script qui prend trop de temps
      const scriptPath = 'test-timeout.ps1';
      const scriptContent = 'Start-Sleep -Seconds 20';
      // Ajouter le fichier au mock au lieu d'utiliser writeFileSync
      mockFiles[join(testDir, scriptPath)] = scriptContent;

      const result = await executor.executeScript(
        scriptPath,
        [],
        { timeout: 1000 } // 1 seconde seulement
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain('timed out');
    }, 15000); // Test timeout de 15s

    it('devrait capturer stdout et stderr séparément', async () => {
      // Configurer le mock pour ce test
      setMockBehavior({
        exitCode: 0,
        stdout: 'This is stdout\nMore stdout',
        stderr: 'This is stderr'
      });

      // Script qui écrit sur les deux flux
      const scriptPath = 'test-streams.ps1';
      const scriptContent = `
        Write-Output "This is stdout"
        Write-Error "This is stderr" -ErrorAction Continue
        Write-Output "More stdout"
      `;
      // Ajouter le fichier au mock au lieu d'utiliser writeFileSync
      mockFiles[join(testDir, scriptPath)] = scriptContent;

      const result = await executor.executeScript(scriptPath, []);

      expect(result.stdout).toContain('This is stdout');
      expect(result.stdout).toContain('More stdout');
      expect(result.stderr).toContain('This is stderr');
    });

    it('devrait gérer les chemins avec espaces', async () => {
      // Configurer le mock pour ce test
      setMockBehavior({
        exitCode: 0,
        stdout: 'Spaces OK',
        stderr: ''
      });

      // Créer un sous-répertoire avec espace
      const subDir = join(testDir, 'test folder');
      mkdirSync(subDir, { recursive: true });
      
      const scriptPath = join('test folder', 'test-space.ps1');
      const scriptContent = 'Write-Output "Spaces OK"';
      // Ajouter le fichier au mock au lieu d'utiliser writeFileSync
      mockFiles[join(testDir, scriptPath)] = scriptContent;

      const result = await executor.executeScript(scriptPath, []);

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Spaces OK');
    });
  });

  describe('parseJsonOutput', () => {
    it('devrait parser une sortie JSON valide', () => {
      const output = '{"success": true, "data": [1, 2, 3]}';
      const parsed = PowerShellExecutor.parseJsonOutput<{ success: boolean; data: number[] }>(output);

      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual([1, 2, 3]);
    });

    it('devrait ignorer les logs avant et après le JSON', () => {
      const output = `
        Starting script...
        Some debug info
        {"result": "ok", "count": 42}
        Script completed
      `;
      const parsed = PowerShellExecutor.parseJsonOutput<{ result: string; count: number }>(output);

      expect(parsed.result).toBe('ok');
      expect(parsed.count).toBe(42);
    });

    it('devrait gérer le JSON sur plusieurs lignes', () => {
      const output = `
        {
          "name": "test",
          "values": [
            1,
            2,
            3
          ]
        }
      `;
      const parsed = PowerShellExecutor.parseJsonOutput<{ name: string; values: number[] }>(output);

      expect(parsed.name).toBe('test');
      expect(parsed.values).toEqual([1, 2, 3]);
    });

    it('devrait rejeter une sortie non-JSON', () => {
      const output = 'This is not JSON';
      
      expect(() => {
        PowerShellExecutor.parseJsonOutput(output);
      }).toThrow();
    });

    it('devrait rejeter une sortie JSON malformée', () => {
      const output = '{"incomplete": ';
      
      expect(() => {
        PowerShellExecutor.parseJsonOutput(output);
      }).toThrow();
    });
  });

  describe('isPowerShellAvailable', () => {
    it('devrait détecter si PowerShell est disponible', async () => {
      const isAvailable = await PowerShellExecutor.isPowerShellAvailable();
      
      // Sur Windows avec PowerShell 7+, devrait être true
      // Sur d'autres systèmes, pourrait être false
      expect(typeof isAvailable).toBe('boolean');
    }, 10000);

    it('devrait retourner false pour un chemin PowerShell invalide', async () => {
      const isAvailable = await PowerShellExecutor.isPowerShellAvailable('invalid-pwsh.exe');
      
      expect(isAvailable).toBe(false);
    }, 10000);
  });

  describe('getPowerShellVersion', () => {
    it('devrait obtenir la version de PowerShell', async () => {
      const version = await PowerShellExecutor.getPowerShellVersion();
      
      if (version) {
        // Vérifier format version (ex: "7.4.0")
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
      } else {
        // PowerShell non disponible sur ce système
        expect(version).toBeNull();
      }
    }, 10000);
  });

  describe('Singleton par défaut', () => {
    it('devrait retourner la même instance', () => {
      const instance1 = getDefaultExecutor();
      const instance2 = getDefaultExecutor();
      
      expect(instance1).toBe(instance2);
    });

    it('devrait créer une nouvelle instance après reset', () => {
      const instance1 = getDefaultExecutor();
      resetDefaultExecutor();
      const instance2 = getDefaultExecutor();
      
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Configuration personnalisée', () => {
    it('devrait accepter un chemin PowerShell personnalisé', () => {
      const customExecutor = new PowerShellExecutor({
        powershellPath: 'custom-pwsh.exe'
      });
      
      expect(customExecutor).toBeInstanceOf(PowerShellExecutor);
    });

    it('devrait accepter un timeout par défaut personnalisé', async () => {
      const customExecutor = new PowerShellExecutor({
        roosyncBasePath: testDir,
        defaultTimeout: 5000
      });

      // Script qui prend 3 secondes
      const scriptPath = 'test-custom-timeout.ps1';
      const scriptContent = 'Start-Sleep -Seconds 3; Write-Output "Done"';
      writeFileSync(join(testDir, scriptPath), scriptContent, 'utf-8');

      const result = await customExecutor.executeScript(scriptPath, []);
      
      // Devrait réussir car 3s < 5s (timeout par défaut)
      expect(result.success).toBe(true);
    }, 10000);

    it('devrait respecter un timeout explicite', async () => {
      // Configurer le mock pour simuler un timeout
      setMockBehavior({
        shouldTimeout: true,
        stdout: '',
        stderr: ''
      });

      // Script qui prend 5 secondes
      const scriptPath = 'test-explicit-timeout.ps1';
      const scriptContent = 'Start-Sleep -Seconds 5; Write-Output "Done"';
      writeFileSync(join(testDir, scriptPath), scriptContent, 'utf-8');

      const result = await executor.executeScript(
        scriptPath,
        [],
        { timeout: 2000 } // 2 secondes explicites
      );
      
      // Devrait échouer par timeout car 5s > 2s
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('timed out');
    }, 10000);
  });

  describe('Gestion des erreurs', () => {
    it('devrait gérer un script inexistant', async () => {
      await expect(
        executor.executeScript('nonexistent-script.ps1', [])
      ).rejects.toThrow();
    });

    it('devrait gérer les variables d\'environnement', async () => {
      // Configurer le mock pour ce test
      setMockBehavior({
        exitCode: 0,
        stdout: 'TEST_VAR=test-value',
        stderr: ''
      });

      const scriptPath = 'test-env.ps1';
      const scriptContent = 'Write-Output "TEST_VAR=$env:TEST_VAR"';
      // Ajouter le fichier au mock au lieu d'utiliser writeFileSync
      mockFiles[join(testDir, scriptPath)] = scriptContent;

      const result = await executor.executeScript(
        scriptPath,
        [],
        { env: { TEST_VAR: 'test-value' } }
      );

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('TEST_VAR=test-value');
    });
  });
});