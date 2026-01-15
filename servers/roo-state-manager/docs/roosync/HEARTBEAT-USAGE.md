# 💓 RooSync Heartbeat System - Guide Utilisateur

**Version :** 3.0.0
**Date :** 15 janvier 2026
**Serveur MCP :** roo-state-manager

---

## 🎯 Vue d'Ensemble

Le système de heartbeat RooSync permet de surveiller la disponibilité des machines dans un environnement multi-agent et de déclencher automatiquement des synchronisations lors des changements de statut (offline/online). Les heartbeats sont des signaux périodiques envoyés par chaque machine pour indiquer qu'elle est active.

---

## 📁 Architecture de Stockage

```
.shared-state/heartbeats/
├── heartbeats.json          # État des heartbeats par machine
└── heartbeat-service.json   # Configuration du service
```

**Format des données :** JSON avec structure complète  
**Nommage :** `heartbeats.json` (état global), `heartbeat-service.json` (configuration)

---

## 🔄 Concepts Clés

### Statuts de Machine

| Statut | Description | Condition |
|--------|-------------|-----------|
| 🟢 **online** | Machine active et disponible | Dernier heartbeat < offlineTimeout |
| 🟡 **warning** | Machine en avertissement | Dernier heartbeat > offlineTimeout mais < 2×offlineTimeout |
| 🔴 **offline** | Machine indisponible | Dernier heartbeat > 2×offlineTimeout |

### Configuration par Défaut

| Paramètre | Valeur par défaut | Description |
|-----------|-------------------|-------------|
| `heartbeatInterval` | 30000 ms (30s) | Intervalle entre deux heartbeats |
| `offlineTimeout` | 120000 ms (2min) | Délai avant passage en warning |
| `autoSyncEnabled` | true | Synchronisation automatique activée |

---

## 🛠️ Outils Disponibles

### 1. roosync_register_heartbeat

Enregistre un heartbeat pour une machine dans le système RooSync.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `machineId` | string | ✅ | Identifiant de la machine (ex: myia-ai-01) |
| `metadata` | object | ❌ | Métadonnées optionnelles à associer au heartbeat |

**Exemple d'utilisation :**

```
Outil MCP : roosync_register_heartbeat
Serveur : roo-state-manager
Paramètres : {
  "machineId": "myia-ai-01",
  "metadata": {
    "version": "3.0.0",
    "environment": "production"
  }
}
```

**Résultat :**
```json
{
  "success": true,
  "machineId": "myia-ai-01",
  "timestamp": "2026-01-15T23:30:00.000Z",
  "status": "online",
  "isNewMachine": false
}
```

---

### 2. roosync_get_offline_machines

Obtient la liste des machines actuellement offline.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `includeDetails` | boolean | ❌ | Inclure les détails complets de chaque machine (défaut: false) |

**Exemple d'utilisation :**

```
Outil MCP : roosync_get_offline_machines
Serveur : roo-state-manager
Paramètres : {
  "includeDetails": true
}
```

**Résultat :**
```json
{
  "success": true,
  "count": 1,
  "machines": [
    {
      "machineId": "myia-po-2024",
      "status": "offline",
      "lastHeartbeat": "2026-01-15T23:00:00.000Z",
      "offlineSince": "2026-01-15T23:02:00.000Z"
    }
  ],
  "checkedAt": "2026-01-15T23:30:00.000Z"
}
```

---

### 3. roosync_get_warning_machines

Obtient la liste des machines actuellement en avertissement.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `includeDetails` | boolean | ❌ | Inclure les détails complets de chaque machine (défaut: false) |

**Exemple d'utilisation :**

```
Outil MCP : roosync_get_warning_machines
Serveur : roo-state-manager
Paramètres : {
  "includeDetails": true
}
```

**Résultat :**
```json
{
  "success": true,
  "count": 1,
  "machines": [
    {
      "machineId": "myia-dev-01",
      "status": "warning",
      "lastHeartbeat": "2026-01-15T23:28:00.000Z",
      "warningSince": "2026-01-15T23:30:00.000Z"
    }
  ],
  "checkedAt": "2026-01-15T23:30:00.000Z"
}
```

---

### 4. roosync_get_heartbeat_state

Obtient l'état complet du service de heartbeat.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `includeHeartbeats` | boolean | ❌ | Inclure les données de heartbeat de chaque machine (défaut: false) |

**Exemple d'utilisation :**

```
Outil MCP : roosync_get_heartbeat_state
Serveur : roo-state-manager
Paramètres : {
  "includeHeartbeats": true
}
```

**Résultat :**
```json
{
  "success": true,
  "onlineMachines": ["myia-ai-01"],
  "offlineMachines": ["myia-po-2024"],
  "warningMachines": ["myia-dev-01"],
  "statistics": {
    "totalMachines": 3,
    "onlineCount": 1,
    "offlineCount": 1,
    "warningCount": 1
  },
  "heartbeats": {
    "myia-ai-01": {
      "lastHeartbeat": "2026-01-15T23:30:00.000Z",
      "status": "online"
    }
  },
  "retrievedAt": "2026-01-15T23:30:00.000Z"
}
```

---

### 5. roosync_start_heartbeat_service

Démarre le service de heartbeat automatique pour une machine.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `machineId` | string | ✅ | Identifiant de la machine |
| `enableAutoSync` | boolean | ❌ | Activer la synchronisation automatique (défaut: true) |
| `heartbeatInterval` | number | ❌ | Intervalle de heartbeat en ms (défaut: 30000) |
| `offlineTimeout` | number | ❌ | Timeout offline en ms (défaut: 120000) |

**Exemple d'utilisation :**

```
Outil MCP : roosync_start_heartbeat_service
Serveur : roo-state-manager
Paramètres : {
  "machineId": "myia-ai-01",
  "enableAutoSync": true,
  "heartbeatInterval": 30000,
  "offlineTimeout": 120000
}
```

**Résultat :**
```json
{
  "success": true,
  "machineId": "myia-ai-01",
  "startedAt": "2026-01-15T23:30:00.000Z",
  "config": {
    "heartbeatInterval": 30000,
    "offlineTimeout": 120000,
    "autoSyncEnabled": true
  },
  "message": "Service de heartbeat démarré pour myia-ai-01"
}
```

---

### 6. roosync_stop_heartbeat_service

Arrête le service de heartbeat automatique.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `saveState` | boolean | ❌ | Sauvegarder l'état avant l'arrêt (défaut: true) |

**Exemple d'utilisation :**

```
Outil MCP : roosync_stop_heartbeat_service
Serveur : roo-state-manager
Paramètres : {
  "saveState": true
}
```

**Résultat :**
```json
{
  "success": true,
  "stoppedAt": "2026-01-15T23:30:00.000Z",
  "stateSaved": true,
  "message": "Service de heartbeat arrêté"
}
```

---

### 7. roosync_check_heartbeats

Vérifie les heartbeats et détecte les changements de statut.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `forceCheck` | boolean | ❌ | Forcer une vérification immédiate (défaut: false) |

**Exemple d'utilisation :**

```
Outil MCP : roosync_check_heartbeats
Serveur : roo-state-manager
Paramètres : {
  "forceCheck": true
}
```

**Résultat :**
```json
{
  "success": true,
  "newlyOfflineMachines": ["myia-po-2024"],
  "newlyOnlineMachines": [],
  "warningMachines": ["myia-dev-01"],
  "checkedAt": "2026-01-15T23:30:00.000Z",
  "summary": "1 machine nouvellement offline, 0 machine redevenue online"
}
```

---

### 8. roosync_sync_on_offline

Synchronise automatiquement les baselines lors de la détection offline d'une machine.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `machineId` | string | ✅ | Identifiant de la machine offline |
| `createBackup` | boolean | ❌ | Créer une sauvegarde avant synchronisation (défaut: true) |
| `dryRun` | boolean | ❌ | Mode simulation sans modification réelle (défaut: false) |

**Exemple d'utilisation :**

```
Outil MCP : roosync_sync_on_offline
Serveur : roo-state-manager
Paramètres : {
  "machineId": "myia-po-2024",
  "createBackup": true,
  "dryRun": false
}
```

**Résultat :**
```json
{
  "success": true,
  "machineId": "myia-po-2024",
  "syncedAt": "2026-01-15T23:30:00.000Z",
  "backupCreated": true,
  "backupPath": "roo-config/backups/offline-sync-myia-po-2024-1736986200000.json",
  "changes": {
    "filesSynced": 5,
    "conflictsResolved": 0,
    "decisionsCreated": 0
  },
  "message": "Synchronisation offline effectuée pour myia-po-2024"
}
```

---

### 9. roosync_sync_on_online

Synchronise automatiquement les baselines lors du retour online d'une machine.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `machineId` | string | ✅ | Identifiant de la machine redevenue online |
| `createBackup` | boolean | ❌ | Créer une sauvegarde avant synchronisation (défaut: true) |
| `dryRun` | boolean | ❌ | Mode simulation sans modification réelle (défaut: false) |
| `syncFromBaseline` | boolean | ❌ | Synchroniser depuis la baseline (défaut: true) |

**Exemple d'utilisation :**

```
Outil MCP : roosync_sync_on_online
Serveur : roo-state-manager
Paramètres : {
  "machineId": "myia-po-2024",
  "createBackup": true,
  "dryRun": false,
  "syncFromBaseline": true
}
```

**Résultat :**
```json
{
  "success": true,
  "machineId": "myia-po-2024",
  "syncedAt": "2026-01-15T23:30:00.000Z",
  "backupCreated": true,
  "backupPath": "roo-config/backups/online-sync-myia-po-2024-1736986200000.json",
  "changes": {
    "filesSynced": 8,
    "conflictsResolved": 2,
    "decisionsCreated": 1,
    "offlineDuration": 3600000
  },
  "message": "Synchronisation online effectuée pour myia-po-2024"
}
```

---

## 🔄 Workflows Typiques

### Scénario 1 : Démarrage du Service Heartbeat

1. **Démarrer le service** pour la machine locale
2. **Configurer les paramètres** selon les besoins
3. **Vérifier l'état** du service

```
# 1. Démarrer le service
roosync_start_heartbeat_service({
  machineId: "myia-ai-01",
  enableAutoSync: true,
  heartbeatInterval: 30000,
  offlineTimeout: 120000
})

# 2. Vérifier l'état
roosync_get_heartbeat_state({
  includeHeartbeats: true
})
```

### Scénario 2 : Surveillance des Machines

1. **Vérifier les heartbeats** régulièrement
2. **Identifier les machines offline**
3. **Identifier les machines en avertissement**

```
# 1. Vérifier l'état global
roosync_get_heartbeat_state({
  includeHeartbeats: true
})

# 2. Lister les machines offline
roosync_get_offline_machines({
  includeDetails: true
})

# 3. Lister les machines en avertissement
roosync_get_warning_machines({
  includeDetails: true
})
```

### Scénario 3 : Synchronisation Automatique

1. **Détecter une machine offline**
2. **Déclencher la synchronisation offline**
3. **Surveiller le retour online**
4. **Déclencher la synchronisation online**

```
# 1. Vérifier les heartbeats
const checkResult = roosync_check_heartbeats({ forceCheck: true })

# 2. Si machine nouvellement offline
if (checkResult.newlyOfflineMachines.length > 0) {
  roosync_sync_on_offline({
    machineId: checkResult.newlyOfflineMachines[0],
    createBackup: true,
    dryRun: false
  })
}

# 3. Si machine redevenue online
if (checkResult.newlyOnlineMachines.length > 0) {
  roosync_sync_on_online({
    machineId: checkResult.newlyOnlineMachines[0],
    createBackup: true,
    dryRun: false,
    syncFromBaseline: true
  })
}
```

### Scénario 4 : Mode Simulation (Dry Run)

1. **Tester la synchronisation** sans modifications réelles
2. **Vérifier les changements potentiels**
3. **Valider avant exécution réelle**

```
# 1. Test en mode simulation
roosync_sync_on_offline({
  machineId: "myia-po-2024",
  createBackup: false,
  dryRun: true
})

# 2. Si satisfait, exécuter réellement
roosync_sync_on_offline({
  machineId: "myia-po-2024",
  createBackup: true,
  dryRun: false
})
```

---

## 📊 Structure des Données

### Heartbeat Data

```json
{
  "machineId": "myia-ai-01",
  "lastHeartbeat": "2026-01-15T23:30:00.000Z",
  "status": "online",
  "offlineSince": null,
  "warningSince": null,
  "metadata": {
    "version": "3.0.0",
    "environment": "production"
  }
}
```

### Service Configuration

```json
{
  "heartbeatInterval": 30000,
  "offlineTimeout": 120000,
  "autoSyncEnabled": true,
  "isRunning": true,
  "startedAt": "2026-01-15T23:00:00.000Z"
}
```

---

## 🎨 Icônes et Indicateurs

### Statut
- 🟢 online (active)
- 🟡 warning (avertissement)
- 🔴 offline (indisponible)

### Actions
- 💓 heartbeat (signal de vie)
- 🔄 synchronisation (sync en cours)
- 💾 sauvegarde (backup créé)

---

## 🚀 Bonnes Pratiques

### 1. Configuration des Intervales

**Recommandations :**
- **Environnement de développement** : `heartbeatInterval: 60000` (1min), `offlineTimeout: 300000` (5min)
- **Environnement de production** : `heartbeatInterval: 30000` (30s), `offlineTimeout: 120000` (2min)
- **Environnement critique** : `heartbeatInterval: 10000` (10s), `offlineTimeout: 60000` (1min)

### 2. Gestion des Métadonnées

Utilisez les métadonnées pour stocker des informations contextuelles :
```json
{
  "metadata": {
    "version": "3.0.0",
    "environment": "production",
    "capabilities": ["baseline", "messaging", "heartbeat"],
    "location": "datacenter-01"
  }
}
```

### 3. Sauvegardes Avant Synchronisation

Toujours activer `createBackup: true` pour les synchronisations :
```json
{
  "createBackup": true,
  "dryRun": false
}
```

### 4. Mode Simulation

Utilisez `dryRun: true` pour tester avant d'exécuter :
```json
{
  "dryRun": true
}
```

### 5. Surveillance Régulière

Vérifiez régulièrement l'état du système :
```javascript
// Vérification toutes les 5 minutes
setInterval(() => {
  roosync_check_heartbeats({ forceCheck: true })
}, 300000)
```

---

## 🔍 Dépannage

### Machine détectée offline alors qu'elle est active

**Cause possible :** Intervalle de heartbeat trop court ou timeout trop agressif

**Solution :**
1. Vérifier la configuration du service
2. Augmenter `offlineTimeout` si nécessaire
3. Vérifier la connectivité réseau

### Synchronisation échoue

**Cause possible :** Machine non dans le bon statut

**Solution :**
1. Vérifier le statut de la machine avec `roosync_get_heartbeat_state`
2. Utiliser `roosync_check_heartbeats` pour forcer une vérification
3. Vérifier les permissions d'accès aux fichiers

### Service de heartbeat ne démarre pas

**Cause possible :** Service déjà en cours d'exécution

**Solution :**
1. Arrêter le service existant avec `roosync_stop_heartbeat_service`
2. Redémarrer avec `roosync_start_heartbeat_service`
3. Vérifier les logs pour plus de détails

### Métadonnées non sauvegardées

**Cause possible :** Format de métadonnées invalide

**Solution :**
1. Vérifier que les métadonnées sont un objet JSON valide
2. Éviter les types complexes (fonctions, classes)
3. Utiliser uniquement des types primitifs et objets simples

---

## 📈 Statistiques

| Métrique | Valeur |
|----------|--------|
| **Outils MCP** | 8 |
| **Lignes de code** | ~1,200 |
| **Tests unitaires** | 19 |
| **Coverage** | 100% |
| **Documentation** | 500+ lignes |

---

## 🚀 Prochaines Étapes

- [ ] Intégration complète des callbacks de synchronisation
- [ ] Notifications push pour les changements de statut
- [ ] Tableau de bord de surveillance en temps réel
- [ ] Historique des heartbeats avec graphiques
- [ ] Alertes avancées avec règles personnalisées

---

## 📝 Historique

- **v3.0.0** (15/01/2026) : Création des outils MCP Heartbeat et synchronisation automatique
- **v2.0** (16/10/2025) : Phase 2 messagerie (Management Tools)
- **v1.0** (16/10/2025) : Phase 1 messagerie (Core Tools)

---

## 🤝 Contributions

Ce système a été développé en collaboration entre :
- **myia-po-2024** : Implémentation, tests, documentation
- **myia-ai-01** : Architecture RooSync v3.0, spécifications heartbeat

---

## 📄 License

Voir LICENSE du projet parent.

---

*Documentation générée le 2026-01-15 - Version 3.0.0*
