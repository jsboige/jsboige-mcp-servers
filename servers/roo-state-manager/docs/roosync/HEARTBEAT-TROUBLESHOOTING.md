# 🔧 RooSync Heartbeat System - Guide de Dépannage

**Version :** 3.0.0
**Date :** 15 janvier 2026
**Serveur MCP :** roo-state-manager

---

## 📚 Table des Matières

1. [Problèmes Courants](#problèmes-courants)
2. [Erreurs Spécifiques](#erreurs-spécifiques)
3. [Diagnostic et Debug](#diagnostic-et-debug)
4. [Récupération et Restauration](#récupération-et-restauration)
5. [Performance et Optimisation](#performance-et-optimisation)
6. [FAQ](#faq)

---

## 🚨 Problèmes Courants

### Problème 1 : Machine détectée offline alors qu'elle est active

**Symptômes :**
- La machine envoie des heartbeats régulièrement
- Le système la détecte comme offline
- Les synchronisations automatiques sont déclenchées inutilement

**Causes possibles :**
1. Intervalle de heartbeat trop court par rapport au timeout
2. Latence réseau excessive
3. Horloge système désynchronisée
4. Service heartbeat mal configuré

**Solutions :**

#### Solution 1 : Ajuster la configuration
```typescript
// Vérifier la configuration actuelle
const state = await roosync_get_heartbeat_state({
  includeHeartbeats: true
});

// Si l'intervalle est trop court, augmentez-le
await roosync_start_heartbeat_service({
  machineId: "myia-ai-01",
  heartbeatInterval: 60000,  // 1 minute au lieu de 30s
  offlineTimeout: 300000     // 5 minutes au lieu de 2min
});
```

#### Solution 2 : Vérifier la synchronisation horloge
```bash
# Sur Linux/Mac
sudo ntpdate -u pool.ntp.org

# Sur Windows
w32tm /resync
```

#### Solution 3 : Vérifier la latence réseau
```bash
# Test de latence vers le stockage partagé
ping -c 10 <shared-storage-host>

# Si la latence est > 100ms, envisagez d'augmenter offlineTimeout
```

---

### Problème 2 : Service de heartbeat ne démarre pas

**Symptômes :**
- `roosync_start_heartbeat_service` échoue
- Erreur "Service already running"
- Aucun heartbeat n'est enregistré

**Causes possibles :**
1. Service déjà en cours d'exécution
2. Permissions insuffisantes sur les fichiers
3. Configuration invalide
4. Conflit de ports ou de ressources

**Solutions :**

#### Solution 1 : Arrêter le service existant
```typescript
// Arrêter le service existant
await roosync_stop_heartbeat_service({
  saveState: true
});

// Redémarrer
await roosync_start_heartbeat_service({
  machineId: "myia-ai-01",
  enableAutoSync: true
});
```

#### Solution 2 : Vérifier les permissions
```bash
# Vérifier les permissions sur le répertoire de stockage
ls -la .shared-state/heartbeats/

# Corriger les permissions si nécessaire
chmod 755 .shared-state/heartbeats/
chmod 644 .shared-state/heartbeats/*.json
```

#### Solution 3 : Vérifier la configuration
```typescript
// Valider la configuration avant de démarrer
try {
  await roosync_start_heartbeat_service({
    machineId: "myia-ai-01",
    heartbeatInterval: 30000,
    offlineTimeout: 120000
  });
} catch (error) {
  console.error("Erreur de configuration:", error.message);
  // Corriger la configuration et réessayer
}
```

---

### Problème 3 : Synchronisation échoue

**Symptômes :**
- `roosync_sync_on_offline` ou `roosync_sync_on_online` échoue
- Erreur "Machine not offline" ou "Machine not online"
- Aucun fichier n'est synchronisé

**Causes possibles :**
1. Machine n'est pas dans le bon statut
2. Permissions insuffisantes sur les fichiers
3. Conflit de synchronisation en cours
4. Stockage partagé inaccessible

**Solutions :**

#### Solution 1 : Vérifier le statut de la machine
```typescript
// Vérifier l'état actuel
const state = await roosync_get_heartbeat_state({
  includeHeartbeats: true
});

const machineData = state.heartbeats["myia-po-2024"];
console.log("Statut:", machineData.status);

// Si le statut n'est pas correct, forcer une vérification
await roosync_check_heartbeats({
  forceCheck: true
});
```

#### Solution 2 : Utiliser le mode simulation
```typescript
// Tester en mode simulation d'abord
const dryRunResult = await roosync_sync_on_offline({
  machineId: "myia-po-2024",
  createBackup: false,
  dryRun: true
});

console.log("Résultat simulation:", dryRunResult);

// Si OK, exécuter réellement
const realResult = await roosync_sync_on_offline({
  machineId: "myia-po-2024",
  createBackup: true,
  dryRun: false
});
```

#### Solution 3 : Vérifier l'accès au stockage partagé
```bash
# Vérifier l'accessibilité
ls -la .shared-state/

# Tester l'écriture
echo "test" > .shared-state/test-write.txt
rm .shared-state/test-write.txt
```

---

### Problème 4 : Métadonnées non sauvegardées

**Symptômes :**
- Les métadonnées ne sont pas persistées
- Elles disparaissent après redémarrage
- Erreur "Invalid metadata format"

**Causes possibles :**
1. Format de métadonnées invalide
2. Types complexes non supportés
3. Taille des métadonnées excessive
4. Problème de persistance

**Solutions :**

#### Solution 1 : Valider le format des métadonnées
```typescript
// ❌ Format invalide (contient une fonction)
const invalidMetadata = {
  version: "3.0.0",
  callback: () => console.log("test")  // Fonction non supportée
};

// ✅ Format valide
const validMetadata = {
  version: "3.0.0",
  environment: "production",
  capabilities: ["baseline", "messaging"],
  cpuUsage: 45.2,
  memoryUsage: 62.8
};

await roosync_register_heartbeat({
  machineId: "myia-ai-01",
  metadata: validMetadata
});
```

#### Solution 2 : Limiter la taille des métadonnées
```typescript
// Vérifier la taille avant envoi
const metadata = {
  // ... vos métadonnées
};

const metadataSize = JSON.stringify(metadata).length;
if (metadataSize > 10000) {  // 10KB max recommandé
  console.warn("Métadonnées trop volumineuses:", metadataSize);
  // Réduire la taille
}
```

#### Solution 3 : Vérifier la persistance
```typescript
// Enregistrer le heartbeat
await roosync_register_heartbeat({
  machineId: "myia-ai-01",
  metadata: { version: "3.0.0" }
});

// Vérifier immédiatement
const state = await roosync_get_heartbeat_state({
  includeHeartbeats: true
});

const savedMetadata = state.heartbeats["myia-ai-01"].metadata;
console.log("Métadonnées sauvegardées:", savedMetadata);
```

---

### Problème 5 : Faux positifs de détection offline

**Symptômes :**
- Machines détectées offline intermittemment
- Alertes fréquentes pour des machines actives
- Statut change rapidement entre online et offline

**Causes possibles :**
1. Timeout offline trop agressif
2. Instabilité réseau
3. Charge système excessive
4. Problème de synchronisation horloge

**Solutions :**

#### Solution 1 : Augmenter le timeout offline
```typescript
// Configuration plus tolérante
await roosync_start_heartbeat_service({
  machineId: "myia-ai-01",
  heartbeatInterval: 30000,
  offlineTimeout: 300000  // 5 minutes au lieu de 2
});
```

#### Solution 2 : Implémenter un filtre de stabilité
```typescript
class StableStatusFilter {
  private statusHistory: Map<string, string[]> = new Map();
  private readonly historySize = 3;

  async checkStableStatus(machineId: string): Promise<string | null> {
    const state = await roosync_get_heartbeat_state({
      includeHeartbeats: true
    });

    const currentStatus = state.heartbeats[machineId]?.status;
    if (!currentStatus) return null;

    // Ajouter à l'historique
    const history = this.statusHistory.get(machineId) || [];
    history.push(currentStatus);
    if (history.length > this.historySize) {
      history.shift();
    }
    this.statusHistory.set(machineId, history);

    // Vérifier si le statut est stable
    if (history.length === this.historySize &&
        history.every(s => s === currentStatus)) {
      return currentStatus;
    }

    return null; // Statut pas encore stable
  }
}
```

#### Solution 3 : Surveiller la latence réseau
```typescript
// Ajouter la latence aux métadonnées
async function registerHeartbeatWithLatency(machineId: string) {
  const startTime = Date.now();

  await roosync_register_heartbeat({
    machineId,
    metadata: {
      latency: Date.now() - startTime,
      timestamp: new Date().toISOString()
    }
  });
}

// Si la latence est élevée, ajuster la configuration
```

---

## 🔍 Erreurs Spécifiques

### Erreur : HEARTBEAT_REGISTRATION_FAILED

**Message :** "Erreur lors de l'enregistrement du heartbeat"

**Causes :**
- Machine ID invalide ou vide
- Problème d'accès au stockage partagé
- Conflit avec un heartbeat existant

**Solution :**
```typescript
try {
  await roosync_register_heartbeat({
    machineId: "myia-ai-01",
    metadata: { version: "3.0.0" }
  });
} catch (error) {
  if (error.code === "HEARTBEAT_REGISTRATION_FAILED") {
    console.error("Échec d'enregistrement:", error.message);

    // Vérifier l'ID de la machine
    if (!machineId || machineId.trim() === "") {
      console.error("Machine ID invalide");
      return;
    }

    // Vérifier l'accès au stockage
    try {
      await fs.access(".shared-state/heartbeats/");
    } catch (accessError) {
      console.error("Accès au stockage impossible:", accessError.message);
      return;
    }
  }
}
```

---

### Erreur : MACHINE_NOT_OFFLINE

**Message :** "La machine X n'est pas offline"

**Causes :**
- Tentative de synchronisation offline sur une machine online
- Statut de la machine pas à jour
- Vérification forcée nécessaire

**Solution :**
```typescript
// Vérifier le statut actuel
const state = await roosync_get_heartbeat_state({
  includeHeartbeats: true
});

const machineStatus = state.heartbeats[machineId]?.status;

if (machineStatus !== "offline") {
  console.log(`Machine ${machineId} est ${machineStatus}, pas offline`);

  // Forcer une vérification
  await roosync_check_heartbeats({
    forceCheck: true
  });

  // Réessayer après vérification
  const newState = await roosync_get_heartbeat_state({
    includeHeartbeats: true
  });

  if (newState.heartbeats[machineId]?.status === "offline") {
    await roosync_sync_on_offline({
      machineId,
      createBackup: true,
      dryRun: false
    });
  }
}
```

---

### Erreur : MACHINE_NOT_ONLINE

**Message :** "La machine X n'est pas online"

**Causes :**
- Tentative de synchronisation online sur une machine offline
- Machine encore en phase de démarrage
- Délai de propagation du statut

**Solution :**
```typescript
// Attendre que la machine soit online
async function waitForOnline(machineId: string, timeoutMs: number = 60000): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const state = await roosync_get_heartbeat_state({
      includeHeartbeats: true
    });

    if (state.heartbeats[machineId]?.status === "online") {
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return false;
}

// Utilisation
const isOnline = await waitForOnline("myia-po-2024", 60000);

if (isOnline) {
  await roosync_sync_on_online({
    machineId: "myia-po-2024",
    createBackup: true,
    dryRun: false
  });
} else {
  console.error("Timeout: machine pas online après 60s");
}
```

---

### Erreur : SYNC_OFFLINE_FAILED / SYNC_ONLINE_FAILED

**Message :** "Erreur lors de la synchronisation offline/online"

**Causes :**
- Problème d'accès aux fichiers
- Conflit de synchronisation
- Espace disque insuffisant
- Permissions insuffisantes

**Solution :**
```typescript
try {
  await roosync_sync_on_offline({
    machineId: "myia-po-2024",
    createBackup: true,
    dryRun: false
  });
} catch (error) {
  if (error.code === "SYNC_OFFLINE_FAILED") {
    console.error("Échec de synchronisation:", error.message);

    // Vérifier l'espace disque
    const diskSpace = await checkDiskSpace(".shared-state/");
    if (diskSpace.free < 100 * 1024 * 1024) {  // < 100MB
      console.error("Espace disque insuffisant");
      return;
    }

    // Vérifier les permissions
    try {
      await fs.access(".shared-state/", fs.constants.W_OK);
    } catch (accessError) {
      console.error("Permissions insuffisantes:", accessError.message);
      return;
    }

    // Réessayer en mode simulation
    const dryRunResult = await roosync_sync_on_offline({
      machineId: "myia-po-2024",
      createBackup: false,
      dryRun: true
    });

    console.log("Mode simulation OK:", dryRunResult);
  }
}
```

---

## 🩺 Diagnostic et Debug

### Outil 1 : Script de Diagnostic Complet

```typescript
/**
 * Script de diagnostic complet du système heartbeat
 */

async function runHeartbeatDiagnostics() {
  console.log("🔍 Diagnostic du système Heartbeat...\n");

  const diagnostics = {
    timestamp: new Date().toISOString(),
    checks: []
  };

  // 1. Vérifier l'état du service
  console.log("1️⃣ Vérification de l'état du service...");
  try {
    const state = await roosync_get_heartbeat_state({
      includeHeartbeats: true
    });

    diagnostics.checks.push({
      name: "Service State",
      status: "OK",
      details: {
        totalMachines: state.statistics.totalMachines,
        online: state.statistics.onlineCount,
        offline: state.statistics.offlineCount,
        warning: state.statistics.warningCount
      }
    });

    console.log(`   ✅ Service actif: ${state.statistics.totalMachines} machines`);
  } catch (error) {
    diagnostics.checks.push({
      name: "Service State",
      status: "FAILED",
      error: error.message
    });
    console.log(`   ❌ Erreur: ${error.message}`);
  }

  // 2. Vérifier l'accès au stockage
  console.log("\n2️⃣ Vérification de l'accès au stockage...");
  try {
    await fs.access(".shared-state/heartbeats/", fs.constants.R_OK | fs.constants.W_OK);

    diagnostics.checks.push({
      name: "Storage Access",
      status: "OK"
    });

    console.log("   ✅ Accès au stockage OK");
  } catch (error) {
    diagnostics.checks.push({
      name: "Storage Access",
      status: "FAILED",
      error: error.message
    });
    console.log(`   ❌ Erreur d'accès: ${error.message}`);
  }

  // 3. Vérifier l'espace disque
  console.log("\n3️⃣ Vérification de l'espace disque...");
  try {
    const diskSpace = await checkDiskSpace(".shared-state/");

    diagnostics.checks.push({
      name: "Disk Space",
      status: diskSpace.free > 100 * 1024 * 1024 ? "OK" : "WARNING",
      details: {
        free: diskSpace.free,
        used: diskSpace.used,
        total: diskSpace.total
      }
    });

    const freeMB = Math.round(diskSpace.free / (1024 * 1024));
    console.log(`   ${diskSpace.free > 100 * 1024 * 1024 ? "✅" : "⚠️"} Espace libre: ${freeMB} MB`);
  } catch (error) {
    diagnostics.checks.push({
      name: "Disk Space",
      status: "FAILED",
      error: error.message
    });
    console.log(`   ❌ Erreur: ${error.message}`);
  }

  // 4. Vérifier les machines offline
  console.log("\n4️⃣ Vérification des machines offline...");
  try {
    const offlineMachines = await roosync_get_offline_machines({
      includeDetails: true
    });

    diagnostics.checks.push({
      name: "Offline Machines",
      status: offlineMachines.count === 0 ? "OK" : "WARNING",
      details: {
        count: offlineMachines.count,
        machines: offlineMachines.machines
      }
    });

    if (offlineMachines.count === 0) {
      console.log("   ✅ Aucune machine offline");
    } else {
      console.log(`   ⚠️ ${offlineMachines.count} machine(s) offline:`);
      for (const machine of offlineMachines.machines) {
        console.log(`      - ${machine.machineId} (depuis ${machine.offlineSince})`);
      }
    }
  } catch (error) {
    diagnostics.checks.push({
      name: "Offline Machines",
      status: "FAILED",
      error: error.message
    });
    console.log(`   ❌ Erreur: ${error.message}`);
  }

  // 5. Vérifier les machines en avertissement
  console.log("\n5️⃣ Vérification des machines en avertissement...");
  try {
    const warningMachines = await roosync_get_warning_machines({
      includeDetails: true
    });

    diagnostics.checks.push({
      name: "Warning Machines",
      status: warningMachines.count === 0 ? "OK" : "WARNING",
      details: {
        count: warningMachines.count,
        machines: warningMachines.machines
      }
    });

    if (warningMachines.count === 0) {
      console.log("   ✅ Aucune machine en avertissement");
    } else {
      console.log(`   ⚠️ ${warningMachines.count} machine(s) en avertissement:`);
      for (const machine of warningMachines.machines) {
        console.log(`      - ${machine.machineId} (depuis ${machine.warningSince})`);
      }
    }
  } catch (error) {
    diagnostics.checks.push({
      name: "Warning Machines",
      status: "FAILED",
      error: error.message
    });
    console.log(`   ❌ Erreur: ${error.message}`);
  }

  // 6. Résumé
  console.log("\n📊 Résumé du diagnostic:");
  const failedChecks = diagnostics.checks.filter(c => c.status === "FAILED");
  const warningChecks = diagnostics.checks.filter(c => c.status === "WARNING");

  console.log(`   ✅ Checks OK: ${diagnostics.checks.length - failedChecks.length - warningChecks.length}`);
  console.log(`   ⚠️ Checks WARNING: ${warningChecks.length}`);
  console.log(`   ❌ Checks FAILED: ${failedChecks.length}`);

  if (failedChecks.length > 0) {
    console.log("\n❌ Actions requises:");
    for (const check of failedChecks) {
      console.log(`   - ${check.name}: ${check.error || "Voir détails"}`);
    }
  }

  // Sauvegarder le diagnostic
  const diagnosticPath = `roo-config/diagnostics/heartbeat-${Date.now()}.json`;
  await fs.writeFile(diagnosticPath, JSON.stringify(diagnostics, null, 2));
  console.log(`\n💾 Diagnostic sauvegardé: ${diagnosticPath}`);

  return diagnostics;
}

// Exécution
runHeartbeatDiagnostics();
```

### Outil 2 : Moniteur en Temps Réel

```typescript
/**
 * Moniteur en temps réel des heartbeats
 */

class RealTimeHeartbeatMonitor {
  private interval: NodeJS.Timeout | null = null;

  start(intervalMs: number = 5000) {
    console.log(`🔴 Démarrage du moniteur (intervalle: ${intervalMs}ms)\n`);

    this.interval = setInterval(async () => {
      await this.displayStatus();
    }, intervalMs);

    // Affichage initial
    this.displayStatus();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log("\n⏹️ Moniteur arrêté");
    }
  }

  async displayStatus() {
    const timestamp = new Date().toLocaleTimeString();
    process.stdout.write(`\r[${timestamp}] `);

    try {
      const state = await roosync_get_heartbeat_state({
        includeHeartbeats: true
      });

      const online = state.statistics.onlineCount;
      const offline = state.statistics.offlineCount;
      const warning = state.statistics.warningCount;

      process.stdout.write(
        `🟢 ${online} | 🟡 ${warning} | 🔴 ${offline} | ` +
        `Total: ${state.statistics.totalMachines}`
      );

      // Afficher les changements récents
      const checkResult = await roosync_check_heartbeats({
        forceCheck: false
      });

      if (checkResult.newlyOfflineMachines.length > 0) {
        console.log(`\n⚠️ Nouvellement offline: ${checkResult.newlyOfflineMachines.join(", ")}`);
      }

      if (checkResult.newlyOnlineMachines.length > 0) {
        console.log(`\n✅ Redevenue online: ${checkResult.newlyOnlineMachines.join(", ")}`);
      }
    } catch (error) {
      process.stdout.write(`❌ Erreur: ${error.message}`);
    }
  }
}

// Utilisation
const monitor = new RealTimeHeartbeatMonitor();
monitor.start(5000);  // Mise à jour toutes les 5 secondes

// Arrêter avec Ctrl+C
process.on('SIGINT', () => {
  monitor.stop();
  process.exit(0);
});
```

---

## 💾 Récupération et Restauration

### Récupération après Crash du Service

```typescript
/**
 * Procédure de récupération après crash du service heartbeat
 */

async function recoverFromCrash() {
  console.log("🔄 Récupération après crash...\n");

  // 1. Vérifier l'état actuel
  console.log("1️⃣ Vérification de l'état...");
  try {
    const state = await roosync_get_heartbeat_state({
      includeHeartbeats: true
    });

    console.log(`   ✅ État récupéré: ${state.statistics.totalMachines} machines`);
  } catch (error) {
    console.log(`   ❌ Impossible de récupérer l'état: ${error.message}`);
    console.log("   ⚠️ Le service doit être réinitialisé");
    return;
  }

  // 2. Arrêter le service s'il est en cours d'exécution
  console.log("\n2️⃣ Arrêt du service...");
  try {
    await roosync_stop_heartbeat_service({
      saveState: true
    });
    console.log("   ✅ Service arrêté");
  } catch (error) {
    console.log(`   ⚠️ Service déjà arrêté: ${error.message}`);
  }

  // 3. Redémarrer le service
  console.log("\n3️⃣ Redémarrage du service...");
  try {
    await roosync_start_heartbeat_service({
      machineId: process.env.MACHINE_ID || "unknown",
      enableAutoSync: true,
      heartbeatInterval: 30000,
      offlineTimeout: 120000
    });
    console.log("   ✅ Service redémarré");
  } catch (error) {
    console.log(`   ❌ Échec du redémarrage: ${error.message}`);
    return;
  }

  // 4. Vérifier que les heartbeats sont enregistrés
  console.log("\n4️⃣ Vérification des heartbeats...");
  await new Promise(resolve => setTimeout(resolve, 2000));  // Attendre 2s

  const newState = await roosync_get_heartbeat_state({
    includeHeartbeats: true
  });

  const myHeartbeat = newState.heartbeats[process.env.MACHINE_ID || "unknown"];
  if (myHeartbeat && myHeartbeat.status === "online") {
    console.log("   ✅ Heartbeat enregistré avec succès");
  } else {
    console.log("   ❌ Heartbeat non enregistré");
  }

  console.log("\n✅ Récupération terminée");
}

// Exécution
recoverFromCrash();
```

### Restauration depuis une Sauvegarde

```typescript
/**
 * Restauration du système depuis une sauvegarde
 */

async function restoreFromBackup(backupPath: string) {
  console.log(`🔄 Restauration depuis ${backupPath}...\n`);

  // 1. Vérifier que la sauvegarde existe
  console.log("1️⃣ Vérification de la sauvegarde...");
  try {
    await fs.access(backupPath);
    console.log("   ✅ Sauvegarde trouvée");
  } catch (error) {
    console.log(`   ❌ Sauvegarde introuvable: ${error.message}`);
    return;
  }

  // 2. Lire la sauvegarde
  console.log("\n2️⃣ Lecture de la sauvegarde...");
  try {
    const backupData = JSON.parse(await fs.readFile(backupPath, "utf-8"));
    console.log("   ✅ Sauvegarde lue");
    console.log(`   📊 Machines: ${Object.keys(backupData.heartbeats || {}).length}`);
  } catch (error) {
    console.log(`   ❌ Erreur de lecture: ${error.message}`);
    return;
  }

  // 3. Arrêter le service
  console.log("\n3️⃣ Arrêt du service...");
  try {
    await roosync_stop_heartbeat_service({
      saveState: false  // Ne pas écraser la sauvegarde
    });
    console.log("   ✅ Service arrêté");
  } catch (error) {
    console.log(`   ⚠️ Service déjà arrêté: ${error.message}`);
  }

  // 4. Restaurer les fichiers
  console.log("\n4️⃣ Restauration des fichiers...");
  try {
    // Copier la sauvegarde vers le répertoire de heartbeats
    await fs.copyFile(
      backupPath,
      ".shared-state/heartbeats/heartbeats.json"
    );
    console.log("   ✅ Fichiers restaurés");
  } catch (error) {
    console.log(`   ❌ Erreur de restauration: ${error.message}`);
    return;
  }

  // 5. Redémarrer le service
  console.log("\n5️⃣ Redémarrage du service...");
  try {
    await roosync_start_heartbeat_service({
      machineId: process.env.MACHINE_ID || "unknown",
      enableAutoSync: true
    });
    console.log("   ✅ Service redémarré");
  } catch (error) {
    console.log(`   ❌ Échec du redémarrage: ${error.message}`);
    return;
  }

  // 6. Vérifier l'état restauré
  console.log("\n6️⃣ Vérification de l'état restauré...");
  const state = await roosync_get_heartbeat_state({
    includeHeartbeats: true
  });

  console.log(`   ✅ État restauré: ${state.statistics.totalMachines} machines`);

  console.log("\n✅ Restauration terminée");
}

// Utilisation
// restoreFromBackup("roo-config/backups/heartbeats-2026-01-15.json");
```

---

## ⚡ Performance et Optimisation

### Optimisation 1 : Réduire la Charge Réseau

```typescript
/**
 * Optimisation : Réduire la charge réseau en regroupant les heartbeats
 */

class BatchHeartbeatManager {
  private pendingHeartbeats: Map<string, any> = new Map();
  private batchInterval: NodeJS.Timeout | null = null;
  private readonly batchSize = 10;
  private readonly batchTimeout = 5000;  // 5 secondes

  async registerHeartbeat(machineId: string, metadata?: any) {
    this.pendingHeartbeats.set(machineId, metadata);

    // Si le batch est plein, envoyer immédiatement
    if (this.pendingHeartbeats.size >= this.batchSize) {
      await this.flushBatch();
    }
  }

  async flushBatch() {
    if (this.pendingHeartbeats.size === 0) return;

    const batch = Array.from(this.pendingHeartbeats.entries());
    this.pendingHeartbeats.clear();

    console.log(`📤 Envoi de ${batch.length} heartbeats en batch`);

    for (const [machineId, metadata] of batch) {
      await roosync_register_heartbeat({
        machineId,
        metadata
      });
    }
  }

  startBatching() {
    this.batchInterval = setInterval(async () => {
      await this.flushBatch();
    }, this.batchTimeout);
  }

  stopBatching() {
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
    this.flushBatch();
  }
}
```

### Optimisation 2 : Cache des États

```typescript
/**
 * Optimisation : Cache des états pour réduire les appels
 */

class CachedHeartbeatState {
  private cache: {
    state: any;
    timestamp: number;
  } | null = null;
  private readonly cacheTimeout = 10000;  // 10 secondes

  async getState(forceRefresh = false): Promise<any> {
    const now = Date.now();

    // Retourner le cache si valide
    if (!forceRefresh && this.cache &&
        now - this.cache.timestamp < this.cacheTimeout) {
      return this.cache.state;
    }

    // Rafraîchir le cache
    const state = await roosync_get_heartbeat_state({
      includeHeartbeats: true
    });

    this.cache = {
      state,
      timestamp: now
    };

    return state;
  }

  invalidate() {
    this.cache = null;
  }
}
```

---

## ❓ FAQ

### Q1 : Combien de machines le système peut-il gérer ?

**R :** Le système peut gérer des centaines de machines. La limitation principale est la capacité du stockage partagé et la bande passante réseau. Pour des clusters de plus de 100 machines, envisagez d'augmenter l'intervalle de heartbeat.

### Q2 : Que se passe-t-il si le stockage partagé est inaccessible ?

**R :** Les heartbeats ne peuvent pas être enregistrés et les machines seront détectées comme offline. Le système continuera de fonctionner localement mais les synchronisations automatiques seront désactivées.

### Q3 : Puis-je utiliser le système heartbeat sans synchronisation automatique ?

**R :** Oui, vous pouvez désactiver la synchronisation automatique en utilisant `enableAutoSync: false` lors du démarrage du service. Les heartbeats seront toujours enregistrés mais aucune synchronisation ne sera déclenchée automatiquement.

### Q4 : Comment puis-je tester le système sans machines réelles ?

**R :** Vous pouvez utiliser le mode simulation (`dryRun: true`) pour tester les synchronisations sans modifications réelles. Vous pouvez également créer des heartbeats manuels avec des métadonnées de test.

### Q5 : Les heartbeats sont-ils chiffrés ?

**R :** Les heartbeats sont stockés en JSON clair dans le stockage partagé. Si vous avez besoin de chiffrement, vous devez l'implémenter au niveau du stockage partagé (ex: chiffrement du répertoire `.shared-state`).

### Q6 : Comment puis-je migrer depuis un autre système de monitoring ?

**R :** Vous pouvez utiliser les outils MCP pour enregistrer des heartbeats depuis votre système existant. Créez un script qui lit les données de votre système actuel et les convertit en appels `roosync_register_heartbeat`.

### Q7 : Le système fonctionne-t-il avec des machines dans différents fuseaux horaires ?

**R :** Oui, le système utilise des timestamps ISO 8601 qui incluent le fuseau horaire. Les comparaisons de temps sont basées sur les timestamps absolus, donc les fuseaux horaires ne posent pas de problème.

### Q8 : Puis-je avoir plusieurs instances du service heartbeat sur la même machine ?

**R :** Non, chaque machine ne peut avoir qu'une seule instance du service heartbeat. Si vous essayez de démarrer une deuxième instance, vous recevrez une erreur "Service already running".

---

## 📞 Support

Si vous rencontrez un problème non couvert par ce guide :

1. Consultez les logs du service dans `.shared-state/logs/`
2. Exécutez le script de diagnostic complet
3. Vérifiez les rapports d'incident dans `roo-config/incidents/`
4. Contactez l'équipe de support avec les détails du problème

---

*Documentation générée le 2026-01-15 - Version 3.0.0*
