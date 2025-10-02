# Documentation de Débogage - roo-state-manager

## Problème Identifié

**Date:** 13 janvier 2025
**Erreur:** Le serveur MCP `roo-state-manager` ne parvenait pas à démarrer en raison d'un export manquant.

### Message d'erreur initial
```
SyntaxError: The requested module './tools/index.js' does not provide an export named 'viewConversationTree'
```

## Analyse SDDD (Semantic-Driven Development & Debugging)

### Phase 1: Grounding Sémantique
- **Recherche sémantique:** Identification des fichiers liés à `viewConversationTree`
- **Exploration architecture:** Compréhension de la structure MCP et des exports

### Phase 2: Diagnostic Précis
1. **Vérification source:** Le fichier [`src/tools/view-conversation-tree.ts`](src/tools/view-conversation-tree.ts:1) existe et exporte correctement `viewConversationTree`
2. **Vérification barrel:** Le fichier [`src/tools/index.ts`](src/tools/index.ts:1) re-exporte correctement la fonction
3. **Problème identifié:** Les fichiers compilés JavaScript étaient absents du répertoire `build/`

### Phase 3: Analyse Build
- **Cause racine:** Configuration TypeScript dans [`tsconfig.json`](tsconfig.json:1)
- **Problème:** `"rootDir": "."` causait une structure de répertoire incorrecte
- **Résultat:** Compilation dans `build/src/` au lieu de `build/`

## Solution Appliquée

### Option 1 Explorée (Non retenue)
Modification du `tsconfig.json` pour corriger la structure de build.
**Rejetée** car cela affectait la compilation des fichiers de test.

### Option 2 Implémentée (Retenue)
Correction du chemin dans la configuration MCP globale :
- **Fichier:** `mcp_settings.json`
- **Changement:** 
  ```diff
  - "D:/dev/roo-extensions/mcps/internal/servers/roo-state-manager/build/index.js"
  + "D:/dev/roo-extensions/mcps/internal/servers/roo-state-manager/build/src/index.js"
  ```

## Commandes de Vérification

### Test du serveur
```bash
cd mcps/internal/servers/roo-state-manager
npm run build
node build/src/index.js --help
```

### Test via MCP
```javascript
// Via l'interface MCP
use_mcp_tool('roo-state-manager', 'minimal_test_tool', {})
use_mcp_tool('roo-state-manager', 'view_conversation_tree', {
  view_mode: 'single', 
  detail_level: 'skeleton'
})
```

## Leçons Apprises

1. **Build Configuration:** Les paramètres `rootDir` et `outDir` dans TypeScript peuvent créer des structures inattendues
2. **Path Mismatch:** Toujours vérifier l'alignement entre la structure de build et la configuration de démarrage
3. **MCP Debugging:** Les outils de test intégrés (`minimal_test_tool`) sont essentiels pour la validation

## État Final

✅ **Serveur opérationnel**  
✅ **Tous les outils fonctionnels**  
✅ **Export `viewConversationTree` résolu**  
✅ **Configuration MCP mise à jour**  

## Fichiers Modifiés

- `mcp_settings.json` (chemin de démarrage corrigé)
- Aucune modification du code source requise

## Validation

Le serveur a été testé avec succès :
- Démarrage sans erreur
- Outil `minimal_test_tool` fonctionnel
- Outil `view_conversation_tree` opérationnel avec données réelles

---
*Documentation générée lors de la mission SDDD du 13 janvier 2025*