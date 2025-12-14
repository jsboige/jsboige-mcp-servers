/**
 * Utilitaire pour fusionner des objets JSON de configuration.
 * Basé sur la logique de Merge-JsonObjects du script legacy deploy-settings.ps1.
 */

export interface MergeOptions {
  /**
   * Stratégie de fusion pour les tableaux.
   * 'replace': Le tableau source remplace le tableau cible (comportement par défaut, plus sûr).
   * 'concat': Les éléments du tableau source sont ajoutés au tableau cible.
   * 'union': Comme concat, mais sans doublons (basé sur l'égalité stricte ou JSON stringify).
   */
  arrayStrategy?: 'replace' | 'concat' | 'union';
}

export class JsonMerger {
  /**
   * Fusionne récursivement l'objet source dans l'objet cible.
   * @param source L'objet contenant les nouvelles valeurs (prioritaire).
   * @param target L'objet existant à mettre à jour.
   * @param options Options de fusion.
   * @returns Un nouvel objet résultant de la fusion.
   */
  public static merge(source: any, target: any, options: MergeOptions = { arrayStrategy: 'replace' }): any {
    // Si la cible est null ou undefined, on retourne la source
    if (target === null || target === undefined) {
      return this.deepClone(source);
    }

    // Si la source est null ou undefined, on retourne la cible
    if (source === null || source === undefined) {
      return this.deepClone(target);
    }

    // Si les types sont différents, la source gagne
    if (typeof source !== typeof target) {
      return this.deepClone(source);
    }

    // Gestion des tableaux
    if (Array.isArray(source) && Array.isArray(target)) {
      return this.mergeArrays(source, target, options.arrayStrategy || 'replace');
    }

    // Gestion des objets simples (non-tableaux)
    if (this.isPlainObject(source) && this.isPlainObject(target)) {
      const result = this.deepClone(target);

      for (const key of Object.keys(source)) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          if (Object.prototype.hasOwnProperty.call(target, key)) {
            // La propriété existe dans les deux, on fusionne récursivement
            result[key] = this.merge(source[key], target[key], options);
          } else {
            // La propriété n'existe pas dans la cible, on l'ajoute
            result[key] = this.deepClone(source[key]);
          }
        }
      }
      return result;
    }

    // Pour les types primitifs (string, number, boolean) ou autres, la source remplace la cible
    return source;
  }

  private static mergeArrays(source: any[], target: any[], strategy: 'replace' | 'concat' | 'union'): any[] {
    if (strategy === 'replace') {
      return this.deepClone(source);
    } else if (strategy === 'concat') {
      return [...this.deepClone(target), ...this.deepClone(source)];
    } else if (strategy === 'union') {
      const result = this.deepClone(target);
      const existingStrings = new Set(result.map((item: any) => JSON.stringify(item)));

      for (const item of source) {
        const itemStr = JSON.stringify(item);
        if (!existingStrings.has(itemStr)) {
          result.push(this.deepClone(item));
          existingStrings.add(itemStr);
        }
      }
      return result;
    }
    return this.deepClone(source);
  }

  private static isPlainObject(obj: any): boolean {
    return (
      obj !== null &&
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      (obj.constructor === Object || obj.constructor === undefined)
    );
  }

  private static deepClone<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    return JSON.parse(JSON.stringify(obj));
  }
}