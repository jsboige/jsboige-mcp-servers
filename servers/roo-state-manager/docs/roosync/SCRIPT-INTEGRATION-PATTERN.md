# Pattern d'Intégration Scripts PowerShell → Outils MCP RooSync

## Principe

Les outils MCP TypeScript orchestrent des scripts PowerShell spécialisés existants pour collecter, valider et synchroniser les configurations.

## Architecture

```
┌─────────────────────────────────────────┐
│  Outil MCP TypeScript (roosync_init)   │
│  ┌──────────────────────────────────┐  │
│  │ 1. Calcule projectRoot depuis   │  │
│  │    __dirname (module ES6)        │  │
│  │ 2. Construit chemin script PS    │  │
│  │ 3. Exécute via execAsync()       │  │
│  │ 4. Parse JSON retourné           │  │
│  │ 5. Enrichit sync-config.json     │  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
              ↓ execAsync
┌─────────────────────────────────────────┐
│  Script PowerShell                      │
│  (Get-MachineInventory.ps1)            │
│  ┌──────────────────────────────────┐  │
│  │ • Collecte données machine       │  │
│  │ • Génère fichier JSON temporaire │  │
│  │ • Retourne chemin fichier        │  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘

## Pattern Standard

### 1. Imports Nécessaires (Module ES6)

```typescript
import { promisify } from 'util';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const execAsync = promisify(exec);

// Définir __dirname pour les modules ES6
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

### 2. Calculer le Chemin Racine du Projet

```typescript
// Depuis mcps/internal/servers/roo-state-manager/src/tools/roosync/roosync_init.ts
// Remonter à la racine : ../../../../../..
const projectRoot = join(dirname(dirname(dirname(dirname(dirname(__dirname))))));
const inventoryScriptPath = join(projectRoot, 'scripts', 'inventory', 'Get-MachineInventory.ps1');
```

### 3. Exécuter le Script PowerShell

```typescript
const inventoryCmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${inventoryScriptPath}" -MachineId "${machineId}"`;

try {
  const { stdout, stderr } = await execAsync(inventoryCmd, {
    timeout: 30000, // 30 secondes max
    cwd: projectRoot
  });

  // Le script retourne le chemin du fichier JSON créé
  const inventoryFilePath = stdout.trim();

  if (inventoryFilePath && existsSync(inventoryFilePath)) {
    const inventoryData = JSON.parse(readFileSync(inventoryFilePath, 'utf-8'));
    // Traiter les données...
  }
} catch (execError: any) {
  console.warn(`⚠️ Échec collecte inventaire: ${execError.message}`);
  // Continuer sans bloquer - graceful degradation
}
```

### 4. Gestion d'Erreur Gracieuse

**CRITIQUE** : L'intégration ne doit JAMAIS bloquer le flux principal.

```typescript
try {
  // Logique d'intégration
} catch (error: any) {
  console.warn(`⚠️ Erreur intégration: ${error.message}`);
  // NE PAS throw - continuer l'exécution
}
```

### 5. Parsing et Intégration des Données

```typescript
// Lire l'inventaire généré
const inventoryData = JSON.parse(readFileSync(inventoryFilePath, 'utf-8'));

// Créer ou enrichir sync-config.json
const configPath = join(sharedPath, 'sync-config.json');
let syncConfig: any;

if (existsSync(configPath) && !force) {
  syncConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
} else {
  syncConfig = {
    version: '2.0.0',
    machines: {}
  };
}

// Ajouter l'inventaire pour cette machine
syncConfig.machines[machineId] = {
  ...inventoryData.inventory,
  lastInventoryUpdate: inventoryData.timestamp,
  paths: inventoryData.paths
};

// Sauvegarder
writeFileSync(configPath, JSON.stringify(syncConfig, null, 2), 'utf-8');
```

## Prérequis Scripts PowerShell

### Convention de Sortie

Les scripts PowerShell DOIVENT :

1. **Retourner le chemin du fichier JSON** généré via `return $OutputPath`
2. **Générer un JSON valide** avec structure cohérente
3. **Utiliser des chemins relatifs** dans les données
4. **Inclure un timestamp** ISO 8601 UTC

### Exemple de Structure JSON

```json
{
  "machineId": "myia-po-2024",
  "timestamp": "2025-10-14T03:00:00.000Z",
  "inventory": {
    "mcpServers": [...],
    "rooModes": [...],
    "sdddSpecs": [...],
    "scripts": {...},
    "tools": {...},
    "systemInfo": {...}
  },
  "paths": {
    "rooExtensions": "c:/dev/roo-extensions",
    "mcpSettings": "C:/Users/.../mcp_settings.json",
    ...
  }
}
```

## Scripts Intégrables

| Script | Outil MCP | Status | Notes |
|--------|-----------|--------|-------|
| [`Get-MachineInventory.ps1`](../../../../scripts/inventory/Get-MachineInventory.ps1) | `roosync_init` | 🔄 En cours | Collecte inventaire complet |
| `validate-mcp-config.ps1` | `roosync_compare_config` | 🔜 Prévu | Validation configuration |
| `sync-config-differences.ps1` | `roosync_list_diffs` | 🔜 Prévu | Détection différences |
| `apply-config-decision.ps1` | `roosync_apply_decision` | 🔜 Prévu | Application décision |

## Bonnes Pratiques

### ✅ À FAIRE

1. **Toujours calculer `projectRoot`** depuis `__dirname` en modules ES6
2. **Utiliser `fileURLToPath(import.meta.url)`** pour obtenir `__filename`
3. **Timeout obligatoire** (30s recommandé) sur `execAsync`
4. **Working directory** : toujours `cwd: projectRoot`
5. **Gestion erreur gracieuse** : ne jamais bloquer le flux
6. **Nettoyer fichiers temporaires** après lecture
7. **Logger toutes les étapes** avec `console.log/warn`
8. **Valider JSON** avant utilisation avec try/catch

### ❌ À ÉVITER

1. **NE PAS utiliser `process.cwd()`** - retourne le répertoire du serveur MCP
2. **NE PAS utiliser `__dirname` directement** en modules ES6 (undefined)
3. **NE PAS bloquer sur erreur script** - fallback requis
4. **NE PAS oublier le timeout** - éviter blocages
5. **NE PAS supposer chemins absolus** - toujours relatifs au projet
6. **NE PAS ignorer stderr** - logger pour debug

## Debugging

### Vérifier le Chemin Calculé

```typescript
console.log('Project root:', projectRoot);
console.log('Script path:', inventoryScriptPath);
console.log('Script exists:', existsSync(inventoryScriptPath));
```

### Tester le Script Manuellement

```powershell
# Depuis la racine du projet
pwsh -NoProfile -ExecutionPolicy Bypass -File "scripts/inventory/Get-MachineInventory.ps1" -MachineId "test-machine"
```

### Logs VS Code

Utiliser l'outil MCP `read_vscode_logs` :

```typescript
await use_mcp_tool('roo-state-manager', 'read_vscode_logs', {
  lines: 100,
  filter: 'inventaire|Get-MachineInventory',
  maxSessions: 2
});
```

## Problèmes Connus

### 1. `__dirname is not defined`

**Cause** : Modules ES6 ne définissent pas `__dirname` automatiquement

**Solution** :
```typescript
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

### 2. Script non trouvé

**Cause** : `process.cwd()` pointe vers le répertoire du serveur MCP, pas la racine du projet

**Solution** : Calculer `projectRoot` depuis `__dirname`

### 3. Erreur de parsing JSON

**Cause** : Script PowerShell a échoué silencieusement

**Solution** :
- Vérifier `stderr` pour erreurs
- Tester script manuellement
- Ajouter logs dans le script PS

## Évolutions Futures

1. **Support scripts Python** : Même pattern avec `python` au lieu de `powershell.exe`
2. **Validation schéma JSON** : Utiliser Zod pour valider structure retournée
3. **Cache résultats** : Éviter recollecte si données récentes
4. **Parallélisation** : Exécuter plusieurs scripts simultanément
5. **Retry logic** : Réessayer en cas d'échec temporaire

## Références

- [Documentation roosync_init](./roosync-init.md)
- [Script Get-MachineInventory.ps1](../../../../scripts/inventory/Get-MachineInventory.ps1)
- [Architecture RooSync v2](./architecture.md)

---

**Dernière mise à jour** : 2025-10-14
**Version** : 1.0.0 (POC)