/**
 * Tests unitaires pour PowerShellExecutor
 *
 * @module tests/unit/services/powershell-executor.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PowerShellExecutor, resetDefaultExecutor, getDefaultExecutor } from '../../../src/services/PowerShellExecutor.js';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { EventEmitter } from 'events';

// Mock child_process
vi.mock('child_process', () => {
  return {
    spawn: vi.fn()
  };
});

import { spawn } from 'child_process';

describe('PowerShellExecutor', () => {
  let executor: PowerShellExecutor;
  let testDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
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
    
    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Nettoyer le répertoire de test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Helper to mock spawn process
  const mockSpawnProcess = (stdout = '', stderr = '', exitCode = 0, delay = 0) => {
    const mockProcess = new EventEmitter() as any;
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    mockProcess.kill = vi.fn();
    
    (spawn as any).mockReturnValue(mockProcess);

    // Use setTimeout to simulate async behavior, but controlled by fake timers
    setTimeout(() => {
      if (stdout) mockProcess.stdout.emit('data', Buffer.from(stdout));
      if (stderr) mockProcess.stderr.emit('data', Buffer.from(stderr));
      mockProcess.emit('close', exitCode);
    }, delay);

    return mockProcess;
  };

  describe('executeScript', () => {
    it('devrait exécuter une commande PowerShell simple', async () => {
      mockSpawnProcess('Hello from PowerShell\n');
      
      const scriptPath = 'test-echo.ps1';
      const scriptContent = 'Write-Output "Hello from PowerShell"';
      writeFileSync(join(testDir, scriptPath), scriptContent, 'utf-8');

      const promise = executor.executeScript(scriptPath, []);
      vi.runAllTimers();
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Hello from PowerShell');
      expect(spawn).toHaveBeenCalled();
    });

    it('devrait gérer les arguments du script', async () => {
      mockSpawnProcess('Name: Alice, Age: 30\n');
      
      const scriptPath = 'test-params.ps1';
      const scriptContent = '...'; // Content doesn't matter for mock
      writeFileSync(join(testDir, scriptPath), scriptContent, 'utf-8');

      const promise = executor.executeScript(
        scriptPath,
        ['-Name', 'Alice', '-Age', '30']
      );
      vi.runAllTimers();
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Name: Alice, Age: 30');
      
      // Verify arguments passed to spawn
      const spawnArgs = (spawn as any).mock.calls[0][1];
      expect(spawnArgs).toContain('-Name');
      expect(spawnArgs).toContain('Alice');
    });

    it('devrait détecter les erreurs PowerShell', async () => {
      mockSpawnProcess('', 'This is an error\n', 1);
      
      const scriptPath = 'test-error.ps1';
      writeFileSync(join(testDir, scriptPath), '...', 'utf-8');

      const promise = executor.executeScript(scriptPath, []);
      vi.runAllTimers();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('This is an error');
    });

    it('devrait gérer le timeout', async () => {
      // Mock process that doesn't emit close immediately
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockProcess.kill = vi.fn();
      (spawn as any).mockReturnValue(mockProcess);

      const scriptPath = 'test-timeout.ps1';
      writeFileSync(join(testDir, scriptPath), '...', 'utf-8');

      const promise = executor.executeScript(
        scriptPath,
        [],
        { timeout: 1000 } // 1 second timeout
      );

      // Advance time past timeout
      vi.advanceTimersByTime(1500);
      
      // We need to manually emit close because the process was killed
      // In real implementation, killing process eventually emits close
      // Here we simulate it
      mockProcess.emit('close', null);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain('timed out');
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it('devrait capturer stdout et stderr séparément', async () => {
      mockSpawnProcess('This is stdout\nMore stdout\n', 'This is stderr\n');
      
      const scriptPath = 'test-streams.ps1';
      writeFileSync(join(testDir, scriptPath), '...', 'utf-8');

      const promise = executor.executeScript(scriptPath, []);
      vi.runAllTimers();
      const result = await promise;

      expect(result.stdout).toContain('This is stdout');
      expect(result.stdout).toContain('More stdout');
      expect(result.stderr).toContain('This is stderr');
    });

    it('devrait gérer les chemins avec espaces', async () => {
      mockSpawnProcess('Spaces OK\n');
      
      const subDir = join(testDir, 'test folder');
      mkdirSync(subDir, { recursive: true });
      const scriptPath = join('test folder', 'test-space.ps1');
      writeFileSync(join(testDir, scriptPath), '...', 'utf-8');

      const promise = executor.executeScript(scriptPath, []);
      vi.runAllTimers();
      const result = await promise;

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
      mockSpawnProcess('test\n'); // Correct output for isPowerShellAvailable
      const promise = PowerShellExecutor.isPowerShellAvailable();
      vi.runAllTimers();
      const isAvailable = await promise;
      expect(isAvailable).toBe(true);
    });

    it('devrait retourner false pour un chemin PowerShell invalide', async () => {
      // Mock spawn error
      (spawn as any).mockImplementation(() => {
        const mockProcess = new EventEmitter() as any;
        mockProcess.stdout = new EventEmitter();
        mockProcess.stderr = new EventEmitter();
        mockProcess.kill = vi.fn();
        setTimeout(() => mockProcess.emit('error', new Error('ENOENT')), 10);
        return mockProcess;
      });

      const promise = PowerShellExecutor.isPowerShellAvailable('invalid-pwsh.exe');
      vi.runAllTimers();
      const isAvailable = await promise;
      expect(isAvailable).toBe(false);
    });
  });

  describe('getPowerShellVersion', () => {
    it('devrait obtenir la version de PowerShell', async () => {
      mockSpawnProcess('7.4.0\n');
      const promise = PowerShellExecutor.getPowerShellVersion();
      vi.runAllTimers();
      const version = await promise;
      expect(version).toBe('7.4.0');
    });
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
      mockSpawnProcess('Done\n', '', 0, 100); // 100ms delay
      
      const customExecutor = new PowerShellExecutor({
        roosyncBasePath: testDir,
        defaultTimeout: 5000
      });

      const scriptPath = 'test-custom-timeout.ps1';
      writeFileSync(join(testDir, scriptPath), '...', 'utf-8');

      const promise = customExecutor.executeScript(scriptPath, []);
      vi.runAllTimers();
      const result = await promise;

      expect(result.success).toBe(true);
    });

    it('devrait respecter un timeout explicite', async () => {
      // Mock process that hangs
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockProcess.kill = vi.fn();
      (spawn as any).mockReturnValue(mockProcess);

      const scriptPath = 'test-explicit-timeout.ps1';
      writeFileSync(join(testDir, scriptPath), '...', 'utf-8');

      const promise = executor.executeScript(
        scriptPath,
        [],
        { timeout: 2000 } // 2 seconds explicit
      );

      // Advance time past timeout
      vi.advanceTimersByTime(2500);
      
      // Simulate process close after kill
      mockProcess.emit('close', null);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.stderr).toContain('timed out');
    });
  });

  describe('Gestion des erreurs', () => {
    it('devrait gérer un script inexistant', async () => {
      await expect(
        executor.executeScript('nonexistent-script.ps1', [])
      ).rejects.toThrow();
    });

    it('devrait gérer les variables d\'environnement', async () => {
      mockSpawnProcess('TEST_VAR=test-value\n');
      
      const scriptPath = 'test-env.ps1';
      writeFileSync(join(testDir, scriptPath), '...', 'utf-8');

      const promise = executor.executeScript(
        scriptPath,
        [],
        { env: { TEST_VAR: 'test-value' } }
      );
      vi.runAllTimers();
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('TEST_VAR=test-value');
      
      // Verify env passed to spawn
      const spawnOptions = (spawn as any).mock.calls[0][2];
      expect(spawnOptions.env).toMatchObject({ TEST_VAR: 'test-value' });
    });
  });
});