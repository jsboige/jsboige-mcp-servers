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

    it('should keep secrets masked during denormalization if no value provided', async () => {
      const service = new ConfigNormalizationService();
      const input = {
        apiKey: '{{SECRET:apiKey}}'
      };

      const result = await service.denormalize(input, 'mcp_config', windowsContext);

      expect(result.apiKey).toBe('{{SECRET:apiKey}}');
    });
  });
});