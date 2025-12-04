/**
 * Tests unitaires pour PowerShellExecutor
 * 
 * @module tests/unit/services/powershell-executor.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Unmock fs and PowerShellExecutor to ensure we test the real implementation
vi.unmock('fs');
vi.unmock('../../../src/services/PowerShellExecutor.js');

import { PowerShellExecutor, resetDefaultExecutor, getDefaultExecutor } from '../../../src/services/PowerShellExecutor.js';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';

describe('PowerShellExecutor', () => {
  let executor: PowerShellExecutor;
  let testDir: string;

  beforeEach(() => {
    // Créer un répertoire de test temporaire
    testDir = join(process.cwd(), 'test-temp-powershell');
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    // Initialiser l'executor avec le répertoire de test
    executor = new PowerShellExecutor({
      roosyncBasePath: testDir,
      defaultTimeout: 10000 // 10s pour les tests
    });

    // Réinitialiser l'instance par défaut
    resetDefaultExecutor();
  });

  afterEach(() => {
    // Nettoyer le répertoire de test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('executeScript', () => {
    it('devrait exécuter une commande PowerShell simple', async () => {
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
      // Script qui génère une erreur
      const scriptPath = 'test-error.ps1';
      const scriptContent = `
        Write-Error "This is an error"
        exit 1
      `;
      writeFileSync(join(testDir, scriptPath), scriptContent, 'utf-8');

      const result = await executor.executeScript(scriptPath, []);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('This is an error');
    });

    it('devrait gérer le timeout', async () => {
      // Script qui prend trop de temps
      const scriptPath = 'test-timeout.ps1';
      const scriptContent = 'Start-Sleep -Seconds 20';
      writeFileSync(join(testDir, scriptPath), scriptContent, 'utf-8');

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
      // Script qui écrit sur les deux flux
      const scriptPath = 'test-streams.ps1';
      const scriptContent = `
        Write-Output "This is stdout"
        Write-Error "This is stderr" -ErrorAction Continue
        Write-Output "More stdout"
      `;
      writeFileSync(join(testDir, scriptPath), scriptContent, 'utf-8');

      const result = await executor.executeScript(scriptPath, []);

      expect(result.stdout).toContain('This is stdout');
      expect(result.stdout).toContain('More stdout');
      expect(result.stderr).toContain('This is stderr');
    });

    it('devrait gérer les chemins avec espaces', async () => {
      // Créer un sous-répertoire avec espace
      const subDir = join(testDir, 'test folder');
      mkdirSync(subDir, { recursive: true });
      
      const scriptPath = join('test folder', 'test-space.ps1');
      const scriptContent = 'Write-Output "Spaces OK"';
      writeFileSync(join(testDir, scriptPath), scriptContent, 'utf-8');

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
      const scriptPath = 'test-env.ps1';
      const scriptContent = 'Write-Output "TEST_VAR=$env:TEST_VAR"';
      writeFileSync(join(testDir, scriptPath), scriptContent, 'utf-8');

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