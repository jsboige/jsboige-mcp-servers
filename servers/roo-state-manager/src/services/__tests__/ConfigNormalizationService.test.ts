import { ConfigNormalizationService, MachineContext } from '../ConfigNormalizationService.js';

describe('ConfigNormalizationService', () => {
  const windowsContext: MachineContext = {
    os: 'windows',
    homeDir: 'C:\\Users\\TestUser',
    rooRoot: 'D:\\Dev\\roo-extensions',
    envVars: {
      APPDATA: 'C:\\Users\\TestUser\\AppData\\Roaming'
    }
  };

  const linuxContext: MachineContext = {
    os: 'linux',
    homeDir: '/home/testuser',
    rooRoot: '/opt/roo-extensions',
    envVars: {
      HOME: '/home/testuser'
    }
  };

  describe('normalize', () => {
    it('should normalize Windows paths to POSIX format', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const input = {
        path: 'C:\\Users\\TestUser\\Documents\\Project',
        nested: {
          file: 'D:\\Dev\\roo-extensions\\src\\index.ts'
        }
      };

      const result = await service.normalize(input, 'mode_definition');

      expect(result.path).toBe('%USERPROFILE%/Documents/Project');
      expect(result.nested.file).toBe('%ROO_ROOT%/src/index.ts');
    });

    it('should normalize Linux paths correctly', async () => {
      const service = new ConfigNormalizationService(linuxContext);
      const input = {
        path: '/home/testuser/Documents/Project',
        nested: {
          file: '/opt/roo-extensions/src/index.ts'
        }
      };

      const result = await service.normalize(input, 'mode_definition');

      expect(result.path).toBe('%USERPROFILE%/Documents/Project');
      expect(result.nested.file).toBe('%ROO_ROOT%/src/index.ts');
    });

    it('should preserve existing environment variables', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const input = {
        appData: '%APPDATA%\\Code\\User',
        linuxVar: '$HOME/config'
      };

      const result = await service.normalize(input, 'mode_definition');

      expect(result.appData).toBe('%APPDATA%/Code/User');
      expect(result.linuxVar).toBe('$HOME/config');
    });

    it('should mask sensitive keys', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const input = {
        apiKey: 'sk-123456789',
        githubToken: 'ghp_abcdef',
        dbPassword: 'secretpassword',
        publicInfo: 'public'
      };

      const result = await service.normalize(input, 'mcp_config');

      expect(result.apiKey).toBe('{{SECRET:apiKey}}');
      expect(result.githubToken).toBe('{{SECRET:githubToken}}');
      expect(result.dbPassword).toBe('{{SECRET:dbPassword}}');
      expect(result.publicInfo).toBe('public');
    });

    it('should not double-mask already masked secrets', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const input = {
        apiKey: '{{SECRET:apiKey}}'
      };

      const result = await service.normalize(input, 'mcp_config');

      expect(result.apiKey).toBe('{{SECRET:apiKey}}');
    });

    it('should preserve Roo ${env:...} references in sensitive keys', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const input = {
        openRouterApiKey: '${env:OPENROUTER_API_KEY}',
        openAiApiKey: '${env:OPENAI_API_KEY}',
        apiKey: '${env:MY_API_KEY}'
      };

      const result = await service.normalize(input, 'mcp_config');

      expect(result.openRouterApiKey).toBe('${env:OPENROUTER_API_KEY}');
      expect(result.openAiApiKey).toBe('${env:OPENAI_API_KEY}');
      expect(result.apiKey).toBe('${env:MY_API_KEY}');
    });

    it('should NOT preserve non-env sensitive values (still mask real secrets)', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const input = {
        apiKey: 'sk-real-secret-value',
        openAiApiKey: 'real-key-value'
      };

      const result = await service.normalize(input, 'mcp_config');

      expect(result.apiKey).toBe('{{SECRET:apiKey}}');
      expect(result.openAiApiKey).toBe('{{SECRET:openAiApiKey}}');
    });

    it('should NOT corrupt regex patterns with backslashes (Bug #537)', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const input = {
        fileRegex: '\\.md$',
        anotherRegex: '\\.(ts|js)$',
        name: 'code-simple',
        description: 'A simple mode for coding'
      };

      const result = await service.normalize(input, 'roomodes_config');

      // Regex patterns must NOT have backslashes converted to forward slashes
      expect(result.fileRegex).toBe('\\.md$');
      expect(result.anotherRegex).toBe('\\.(ts|js)$');
      // Non-path strings should be returned as-is
      expect(result.name).toBe('code-simple');
      expect(result.description).toBe('A simple mode for coding');
    });

    it('should still normalize actual file paths correctly', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const input = {
        configPath: 'C:\\Users\\TestUser\\config.json',
        relativePath: './src/index.ts',
        unixPath: '/home/user/file.txt'
      };

      const result = await service.normalize(input, 'mode_definition');

      expect(result.configPath).toBe('%USERPROFILE%/config.json');
      // Relative and unix paths should be handled
      expect(result.relativePath).toBe('./src/index.ts');
    });

    it('should handle URLs without corruption', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const input = {
        openAiBaseUrl: 'https://api.z.ai/api/anthropic',
        endpoint: 'http://localhost:3000/v1'
      };

      const result = await service.normalize(input, 'model_config');

      expect(result.openAiBaseUrl).toBe('https://api.z.ai/api/anthropic');
      expect(result.endpoint).toBe('http://localhost:3000/v1');
    });
  });

  describe('denormalize', () => {
    it('should denormalize paths for Windows target', async () => {
      const service = new ConfigNormalizationService();
      const input = {
        path: '%USERPROFILE%/Documents/Project',
        root: '%ROO_ROOT%/src/index.ts'
      };

      const result = await service.denormalize(input, 'mode_definition', windowsContext);

      expect(result.path).toBe('C:\\Users\\TestUser\\Documents\\Project');
      expect(result.root).toBe('D:\\Dev\\roo-extensions\\src\\index.ts');
    });

    it('should denormalize paths for Linux target', async () => {
      const service = new ConfigNormalizationService();
      const input = {
        path: '%USERPROFILE%/Documents/Project',
        root: '%ROO_ROOT%/src/index.ts'
      };

      const result = await service.denormalize(input, 'mode_definition', linuxContext);

      expect(result.path).toBe('/home/testuser/Documents/Project');
      expect(result.root).toBe('/opt/roo-extensions/src/index.ts');
    });

    it('should keep secrets masked during denormalization if no env var found', async () => {
      const service = new ConfigNormalizationService();
      const input = {
        apiKey: '{{SECRET:apiKey}}'
      };

      const contextNoEnv: MachineContext = { ...windowsContext, envVars: {} };
      const result = await service.denormalize(input, 'mcp_config', contextNoEnv);

      expect(result.apiKey).toBe('{{SECRET:apiKey}}');
    });

    it('should restore secrets from env vars during denormalization (#759)', async () => {
      const service = new ConfigNormalizationService();
      const input = {
        apiKey: '{{SECRET:apiKey}}',
        githubToken: '{{SECRET:githubToken}}'
      };

      const contextWithEnv: MachineContext = {
        ...windowsContext,
        envVars: {
          apiKey: 'sk-real-api-key-123',
          githubToken: 'ghp_token456'
        }
      };
      const result = await service.denormalize(input, 'mcp_config', contextWithEnv);

      expect(result.apiKey).toBe('sk-real-api-key-123');
      expect(result.githubToken).toBe('ghp_token456');
    });

    it('should NOT modify regex patterns during denormalization (#759)', async () => {
      const service = new ConfigNormalizationService();
      const input = {
        pattern: '\\.md$',
        filter: '^src/.*\\.ts$',
        normalPath: '%USERPROFILE%/Documents'
      };

      const result = await service.denormalize(input, 'mcp_config', windowsContext);

      // Regex patterns must be preserved as-is
      expect(result.pattern).toBe('\\.md$');
      expect(result.filter).toBe('^src/.*\\.ts$');
      // But paths with placeholders must be denormalized
      expect(result.normalPath).toContain('TestUser');
    });

    it('should use default context when none provided (#759)', async () => {
      const service = new ConfigNormalizationService();
      const input = { simple: 'value' };

      // Should not throw when no context provided
      const result = await service.denormalize(input, 'mcp_config');
      expect(result.simple).toBe('value');
    });
  });
});