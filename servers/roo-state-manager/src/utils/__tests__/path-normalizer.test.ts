/**
 * Tests pour path-normalizer
 */

import { describe, it, expect } from 'vitest';
import { normalizePath } from '../path-normalizer';

describe('path-normalizer', () => {
  describe('normalizePath', () => {
    it('devrait retourner une chaîne vide pour une entrée vide', () => {
      expect(normalizePath('')).toBe('');
      expect(normalizePath('   ')).toBe('   '); // Pas de trim
    });

    it('devrait retourner une chaîne vide pour undefined', () => {
      // @ts-ignore - Test cas limite
      expect(normalizePath()).toBe('');
      expect(normalizePath(undefined as any)).toBe('');
    });

    it('devrait convertir les backslashes en forward slashes', () => {
      expect(normalizePath('C:\\Users\\test\\file.txt')).toBe('c:/users/test/file.txt');
      expect(normalizePath('path\\to\\file')).toBe('path/to/file');
    });

    it('devrait supprimer les slashes de fin', () => {
      expect(normalizePath('path/to/folder/')).toBe('path/to/folder');
      expect(normalizePath('path/to/folder//')).toBe('path/to/folder');
      expect(normalizePath('C:\\path\\folder\\')).toBe('c:/path/folder');
    });

    it('devrait convertir en minuscules pour éviter les problèmes de casse', () => {
      expect(normalizePath('Path/To/File')).toBe('path/to/file');
      expect(normalizePath('C:\\Users\\Test\\FILE.TXT')).toBe('c:/users/test/file.txt');
    });

    it('devrait gérer les chemins mixtes (backslashes et forward slashes)', () => {
      expect(normalizePath('path\\to/mixed/folder\\file')).toBe('path/to/mixed/folder/file');
    });

    it('devrait préserver les chemins relatifs', () => {
      expect(normalizePath('./relative/path')).toBe('./relative/path');
      expect(normalizePath('../parent/path')).toBe('../parent/path');
    });
  });
});
