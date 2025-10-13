# 🔧 Correctif Bug Corruption mcp_settings.json

## 📌 Résumé

Ce document décrit le correctif appliqué pour résoudre un bug critique de corruption du fichier [`mcp_settings.json`](C:/Users/MYIA/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json).

**Date du correctif :** 2025-10-13  
**Sévérité :** 🔴 CRITIQUE  
**Status :** ✅ Correctif appliqué - À tester

---

## 🐛 Problème Identifié

L'outil `restart_mcp_servers` dans [`quickfiles-server/src/index.ts`](./src/index.ts) pouvait corrompre le fichier `mcp_settings.json` en :

1. **Ne relisant pas le fichier entre les écritures** - Le fichier était lu une seule fois au début, puis écrit plusieurs fois
2. **Créant des race conditions** - Les modifications d'autres processus étaient écrasées
3. **Risquant des écritures partielles** - Pas de mécanisme de protection contre les interruptions

### Symptômes Observés

- Braces `}` en trop à la fin du fichier
- JSON invalide
- Impossibilité de démarrer les serveurs MCP
- Perte de configuration

---

## ✅ Correctif Appliqué

### Changements dans `src/index.ts`

La fonction `handleRestartMcpServers` a été modifiée pour :

1. **Relire le fichier avant chaque modification**
   ```typescript
   // Avant chaque serveur
   let settingsRaw = await fs.readFile(settingsPath, 'utf-8');
   let settings = JSON.parse(settingsRaw);
   ```

2. **Relire entre la désactivation et la réactivation**
   ```typescript
   // Après désactivation, relire avant de réactiver
   settingsRaw = await fs.readFile(settingsPath, 'utf-8');
   settings = JSON.parse(settingsRaw);
   ```

3. **Ajouter le paramètre encoding explicite**
   ```typescript
   await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
   ```

### Code Avant (❌ Bugué)

```typescript
private async handleRestartMcpServers(args: z.infer<typeof RestartMcpServersArgsSchema>) {
  const { servers } = args;
  const settingsPath = '...';
  const results = [];
  try {
    // ❌ Lecture unique au début
    const settingsRaw = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsRaw);
    
    for (const serverName of servers) {
      if (settings.mcpServers[serverName]) {
          settings.mcpServers[serverName].enabled = false;
          await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2)); // ❌ Pas de relecture
          await new Promise(resolve => setTimeout(resolve, 1000));
          settings.mcpServers[serverName].enabled = true;
          await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2)); // ❌ Pas de relecture
          results.push({ server: serverName, status: 'success' });
      }
    }
  } catch (error) {
     return { content: [{ type: 'text' as const, text: `Erreur: ${error.message}` }]};
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(results) }] };
}
```

### Code Après (✅ Corrigé)

```typescript
private async handleRestartMcpServers(args: z.infer<typeof RestartMcpServersArgsSchema>) {
  const { servers } = args;
  const settingsPath = '...';
  const results = [];
  try {
    // ✅ Relecture pour chaque serveur
    for (const serverName of servers) {
      let settingsRaw = await fs.readFile(settingsPath, 'utf-8');
      let settings = JSON.parse(settingsRaw);
      
      if (!settings.mcpServers) {
        throw new Error("La section 'mcpServers' est manquante dans le fichier de configuration.");
      }
      
      if (settings.mcpServers[serverName]) {
          settings.mcpServers[serverName].enabled = false;
          await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // ✅ Relecture avant réactivation
          settingsRaw = await fs.readFile(settingsPath, 'utf-8');
          settings = JSON.parse(settingsRaw);
          
          settings.mcpServers[serverName].enabled = true;
          await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
          results.push({ server: serverName, status: 'success' });
      } else {
          results.push({ server: serverName, status: 'error', reason: 'Server not found in settings' });
      }
    }
  } catch (error) {
     return { content: [{ type: 'text' as const, text: `Erreur: ${error.message}` }]};
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(results) }] };
}
```

---

## 🧪 Tests de Validation

### Script de Test Automatique

Un script de test a été créé : [`test-restart-fix.ts`](./test-restart-fix.ts)

**Pour exécuter les tests :**

```bash
cd mcps/internal/servers/quickfiles-server
npx ts-node test-restart-fix.ts
```

### Tests Inclus

1. **Test 1 : Redémarrages séquentiels multiples**
   - Redémarre plusieurs serveurs l'un après l'autre
   - Vérifie que le JSON reste valide après chaque redémarrage

2. **Test 2 : Persistance des modifications**
   - Vérifie qu'aucun serveur n'est perdu pendant les redémarrages
   - Confirme que tous les serveurs sont toujours présents après les tests

3. **Test 3 : Intégrité du JSON**
   - Vérifie l'équilibre des braces `{}`
   - S'assure qu'il n'y a pas de contenu parasite après la dernière brace

### Tests Manuels Recommandés

1. **Test de redémarrage unique :**
   ```typescript
   use_mcp_tool quickfiles restart_mcp_servers {"servers": ["git"]}
   ```
   - Vérifier que le JSON reste valide
   - Confirmer que le serveur git redémarre correctement

2. **Test de redémarrages multiples :**
   ```typescript
   use_mcp_tool quickfiles restart_mcp_servers {"servers": ["quickfiles", "git", "roo-state-manager"]}
   ```
   - Vérifier que tous les serveurs redémarrent
   - Confirmer l'absence de corruption

3. **Test de race condition (avancé) :**
   - Lancer deux redémarrages en parallèle depuis deux terminaux différents
   - Vérifier que le fichier n'est pas corrompu

---

## 📦 Déploiement

### Étapes de Déploiement

1. **Recompiler le serveur :**
   ```bash
   cd mcps/internal/servers/quickfiles-server
   npm run build
   ```

2. **Redémarrer le serveur Quickfiles :**
   - Via l'outil MCP :
     ```typescript
     use_mcp_tool quickfiles restart_mcp_servers {"servers": ["quickfiles"]}
     ```
   - Ou redémarrer Roo-Code/VS Code complètement

3. **Vérifier le bon fonctionnement :**
   ```bash
   npx ts-node test-restart-fix.ts
   ```

### Fichiers Modifiés

- ✅ [`src/index.ts`](./src/index.ts) - Fonction `handleRestartMcpServers` corrigée
- ✅ [`build/index.js`](./build/index.js) - Version compilée avec le correctif
- 📝 [`test-restart-fix.ts`](./test-restart-fix.ts) - Script de tests de validation (nouveau)
- 📝 [`BUGFIX-README.md`](./BUGFIX-README.md) - Cette documentation (nouveau)

---

## 🔮 Améliorations Futures

### Solution 2 : Écriture Atomique (Recommandée)

Pour une robustesse accrue, considérer l'implémentation d'une écriture atomique :

```typescript
const writeSettingsAtomic = async (settings: any): Promise<void> => {
  const tmpPath = settingsPath + '.tmp';
  const content = JSON.stringify(settings, null, 2);
  
  // Valider le JSON
  JSON.parse(content);
  
  // Écrire dans un fichier temporaire
  await fs.writeFile(tmpPath, content, 'utf-8');
  
  // Renommer atomiquement
  await fs.rename(tmpPath, settingsPath);
};
```

### Solution 3 : Système de Verrouillage (Production)

Pour une protection maximale contre les race conditions :

```bash
npm install proper-lockfile
```

```typescript
import lockfile from 'proper-lockfile';

// Acquérir un lock avant modification
const release = await lockfile.lock(settingsPath);
try {
  // Modifications...
} finally {
  await release();
}
```

---

## 📚 Documentation Complète

Pour une analyse détaillée du bug, consultez :

📄 **[Documentation complète du bug](../../../docs/debugging/mcp_settings_corruption_bug.md)**

Cette documentation contient :
- Analyse détaillée de la cause racine
- Scénarios de corruption
- Solutions alternatives (2 et 3)
- Tests de validation complets
- Script de réparation pour fichiers corrompus

---

## 🆘 Support

### En cas de problème après le correctif

1. **Le correctif ne fonctionne pas :**
   - Vérifier que la compilation a réussi (`npm run build`)
   - Redémarrer complètement VS Code
   - Vérifier les logs du serveur Quickfiles

2. **Le fichier est toujours corrompu :**
   - Consulter le script de réparation dans la documentation complète
   - Restaurer depuis une sauvegarde si disponible
   - Contacter l'équipe de développement

3. **Questions ou suggestions :**
   - Créer une issue dans le repository
   - Consulter la documentation du projet

---

**Correctif appliqué par :** Roo Debug  
**Date :** 2025-10-13T15:17:00Z  
**Version :** 1.0.0-bugfix-mcp-settings-corruption