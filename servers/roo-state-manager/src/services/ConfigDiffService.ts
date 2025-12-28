import { v4 as uuidv4 } from 'uuid';
import { ConfigChange, DiffResult } from '../types/config-sharing.js';

export class ConfigDiffService {
  /**
   * Compare deux configurations et génère un rapport de différences.
   * @param baseline La configuration de référence (cible).
   * @param current La configuration actuelle (source).
   * @param sourceVersion Version de la source (ex: "local").
   * @param targetVersion Version de la cible (ex: "baseline-v1").
   */
  public compare(baseline: any, current: any, sourceVersion: string = 'local', targetVersion: string = 'baseline'): DiffResult {
    const changes: ConfigChange[] = [];
    this.deepCompare(baseline, current, [], changes);

    return {
      timestamp: new Date().toISOString(),
      sourceVersion,
      targetVersion,
      changes,
      summary: {
        added: changes.filter(c => c.type === 'add').length,
        modified: changes.filter(c => c.type === 'modify').length,
        deleted: changes.filter(c => c.type === 'delete').length,
        conflicts: 0
      }
    };
  }

  private deepCompare(baseline: any, current: any, path: string[], changes: ConfigChange[]): void {
    // Cas 1: Types différents ou valeurs primitives différentes
    if (typeof baseline !== typeof current) {
      this.addChange(changes, path, 'modify', baseline, current);
      return;
    }

    // Cas 2: Primitives (string, number, boolean, null, undefined)
    if (typeof baseline !== 'object' || baseline === null || current === null) {
      if (baseline !== current) {
        this.addChange(changes, path, 'modify', baseline, current);
      }
      return;
    }

    // Cas 3: Tableaux
    if (Array.isArray(baseline) && Array.isArray(current)) {
      const maxLen = Math.max(baseline.length, current.length);
      for (let i = 0; i < maxLen; i++) {
        const newPath = [...path, i.toString()];
        if (i >= baseline.length) {
          // Présent dans current, absent dans baseline -> Add
          this.addChange(changes, newPath, 'add', undefined, current[i]);
        } else if (i >= current.length) {
          // Présent dans baseline, absent dans current -> Delete
          this.addChange(changes, newPath, 'delete', baseline[i], undefined);
        } else {
          this.deepCompare(baseline[i], current[i], newPath, changes);
        }
      }
      return;
    }

    // Cas 4: Objets
    const baselineKeys = Object.keys(baseline);
    const currentKeys = Object.keys(current);
    const allKeys = new Set([...baselineKeys, ...currentKeys]);

    for (const key of allKeys) {
      const newPath = [...path, key];
      const inBaseline = key in baseline;
      const inCurrent = key in current;

      if (inCurrent && !inBaseline) {
        this.addChange(changes, newPath, 'add', undefined, current[key]);
      } else if (!inCurrent && inBaseline) {
        this.addChange(changes, newPath, 'delete', baseline[key], undefined);
      } else {
        this.deepCompare(baseline[key], current[key], newPath, changes);
      }
    }
  }

  private addChange(changes: ConfigChange[], path: string[], type: 'add' | 'modify' | 'delete', oldValue: any, newValue: any): void {
    changes.push({
      id: uuidv4(),
      path,
      type,
      oldValue,
      newValue,
      severity: this.calculateSeverity(path, type)
    });
  }

  private calculateSeverity(path: string[], type: 'add' | 'modify' | 'delete'): 'info' | 'warning' | 'critical' {
    const key = path[path.length - 1];
    
    // Détection de clés sensibles
    if (key && /secret|password|token|key|auth|credential/i.test(key)) {
      return 'critical';
    }
    
    // Suppressions potentiellement dangereuses
    if (type === 'delete') {
      return 'warning';
    }

    return 'info';
  }
}