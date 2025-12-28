import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigDiffService } from '../ConfigDiffService';

describe('ConfigDiffService', () => {
  let service: ConfigDiffService;

  beforeEach(() => {
    service = new ConfigDiffService();
  });

  it('should detect no changes for identical objects', () => {
    const config = { a: 1, b: 'test' };
    const report = service.compare(config, config);
    expect(report.changes).toHaveLength(0);
    expect(report.summary.added).toBe(0);
    expect(report.summary.modified).toBe(0);
    expect(report.summary.deleted).toBe(0);
  });

  it('should detect added keys', () => {
    const baseline = { a: 1 };
    const current = { a: 1, b: 2 };
    const report = service.compare(baseline, current);
    
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({
      type: 'add',
      path: ['b'],
      newValue: 2
    });
    expect(report.summary.added).toBe(1);
  });

  it('should detect deleted keys', () => {
    const baseline = { a: 1, b: 2 };
    const current = { a: 1 };
    const report = service.compare(baseline, current);
    
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({
      type: 'delete',
      path: ['b'],
      oldValue: 2
    });
    expect(report.summary.deleted).toBe(1);
  });

  it('should detect modified values', () => {
    const baseline = { a: 1 };
    const current = { a: 2 };
    const report = service.compare(baseline, current);
    
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({
      type: 'modify',
      path: ['a'],
      oldValue: 1,
      newValue: 2
    });
    expect(report.summary.modified).toBe(1);
  });

  it('should handle nested objects', () => {
    const baseline = { 
      server: { 
        port: 8080, 
        host: 'localhost' 
      } 
    };
    const current = { 
      server: { 
        port: 9090, 
        host: 'localhost',
        ssl: true 
      } 
    };
    const report = service.compare(baseline, current);
    
    expect(report.changes).toHaveLength(2);
    
    const modifyChange = report.changes.find(c => c.type === 'modify');
    expect(modifyChange).toBeDefined();
    expect(modifyChange?.path).toEqual(['server', 'port']);
    expect(modifyChange?.oldValue).toBe(8080);
    expect(modifyChange?.newValue).toBe(9090);

    const addChange = report.changes.find(c => c.type === 'add');
    expect(addChange).toBeDefined();
    expect(addChange?.path).toEqual(['server', 'ssl']);
    expect(addChange?.newValue).toBe(true);
  });

  it('should handle arrays (positional)', () => {
    const baseline = { list: [1, 2, 3] };
    const current = { list: [1, 4, 3, 5] };
    const report = service.compare(baseline, current);
    
    // Attendu:
    // index 1: 2 -> 4 (modify)
    // index 3: ajout de 5 (add)
    
    expect(report.changes).toHaveLength(2);
    
    const modifyChange = report.changes.find(c => c.type === 'modify');
    expect(modifyChange?.path).toEqual(['list', '1']);
    expect(modifyChange?.oldValue).toBe(2);
    expect(modifyChange?.newValue).toBe(4);

    const addChange = report.changes.find(c => c.type === 'add');
    expect(addChange?.path).toEqual(['list', '3']);
    expect(addChange?.newValue).toBe(5);
  });

  it('should detect critical severity for secrets', () => {
    const baseline = { apiKey: 'old-key' };
    const current = { apiKey: 'new-key' };
    const report = service.compare(baseline, current);
    
    expect(report.changes[0].severity).toBe('critical');
  });

  it('should detect warning severity for deletions', () => {
    const baseline = { feature: true };
    const current = {};
    const report = service.compare(baseline, current);
    
    expect(report.changes[0].severity).toBe('warning');
  });
});