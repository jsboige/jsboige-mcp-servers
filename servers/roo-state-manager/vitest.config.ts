import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Globals pour avoir describe, it, expect disponibles sans import
    globals: true,
    
    // Environnement Node.js (comme Jest)
    environment: 'node',
    
    // Patterns de tests (équivalent à testMatch de Jest)
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.js',
      'tests/integration/**/*.test.ts',
      'tests/integration/**/*.test.js',
      'tests/e2e/**/*.test.ts',
      'src/**/__tests__/**/*.test.ts'
    ],
    
    // Exclusions (équivalent à testPathIgnorePatterns)
    exclude: [
      'node_modules',
      'build',
      'dist',
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**'
    ],
    
    // Setup files (équivalent à setupFilesAfterEnv)
    setupFiles: ['./tests/setup-env.ts'],
    
    // Global setup (création du stockage temporaire)
    // Note: Dans Vitest v3, globalSetup retourne une fonction de teardown
    globalSetup: './tests/config/globalSetup.ts',
    
    // Timeout (30 secondes comme Jest)
    testTimeout: 30000,
    hookTimeout: 30000,
    
    // Pool configuration - utiliser 'forks' avec un seul worker
    // (équivalent à maxWorkers: 1 de Jest pour éviter les problèmes de mémoire)
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true  // Un seul processus fork (équivalent à maxWorkers: 1)
      }
    },
    
    // Mocks
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/',
        'build/',
        'dist/',
        'tests/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData/',
        'coverage/**',
        '**/__tests__/**',
        '**/vitest-migration/**'
      ],
      // Seuils de couverture (optionnel) - syntaxe Vitest v3
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 50,
        statements: 50
      }
    },
    
    // Isolate pour éviter les fuites entre tests
    isolate: true,
    
    // Reporters
    reporters: ['verbose']
  },
  
  // Résolution des modules (équivalent à moduleNameMapper)
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // Permettre l'import de .js qui résolvent vers .ts (compatibilité ESM)
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json']
  }
});