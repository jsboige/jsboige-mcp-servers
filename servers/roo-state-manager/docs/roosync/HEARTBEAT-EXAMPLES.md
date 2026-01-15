# 💓 RooSync Heartbeat System - Exemples d'Utilisation

**Version :** 3.0.0
**Date :** 15 janvier 2026
**Serveur MCP :** roo-state-manager

---

## 📚 Table des Matières

1. [Exemples de Base](#exemples-de-base)
2. [Scénarios Complets](#scénarios-complets)
3. [Intégration avec Autres Services](#intégration-avec-autres-services)
4. [Scripts d'Automatisation](#scripts-dautomatisation)
5. [Cas d'Usage Avancés](#cas-dusage-avancés)

---

## 🎯 Exemples de Base

### Exemple 1 : Enregistrement d'un Heartbeat Simple

```typescript
// Enregistrement d'un heartbeat pour une machine
const result = await roosync_register_heartbeat({
  machineId: "myia-ai-01"
});

// Résultat attendu
{
  "success": true,
  "machineId": "myia-ai-01",
  "timestamp": "2026-01-15T23:30:00.000Z",
  "status": "online",
  "isNewMachine": true
}
```

### Exemple 2 : Enregistrement avec Métadonnées

```typescript
// Enregistrement avec métadonnées contextuelles
const result = await roosync_register_heartbeat({
  machineId: "myia-ai-01",
  metadata: {
    version: "3.0.0",
    environment: "production",
    capabilities: ["baseline", "messaging", "heartbeat"],
    location: "datacenter-01",
    cpuUsage: 45.2,
    memoryUsage: 62.8
  }
});

// Résultat attendu
{
  "success": true,
  "machineId": "myia-ai-01",
  "timestamp": "2026-01-15T23:30:00.000Z",
  "status": "online",
  "isNewMachine": false
}
```

### Exemple 3 : Démarrage du Service Heartbeat

```typescript
// Démarrage avec configuration personnalisée
const result = await roosync_start_heartbeat_service({
  machineId: "myia-ai-01",
  enableAutoSync: true,
  heartbeatInterval: 30000,  // 30 secondes
  offlineTimeout: 120000      // 2 minutes
});

// Résultat attendu
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

### Exemple 4 : Vérification des Machines Offline

```typescript
// Récupération des machines offline avec détails
const result = await roosync_get_offline_machines({
  includeDetails: true
});

// Résultat attendu
{
  "success": true,
  "count": 2,
  "machines": [
    {
      "machineId": "myia-po-2024",
      "status": "offline",
      "lastHeartbeat": "2026-01-15T23:00:00.000Z",
      "offlineSince": "2026-01-15T23:02:00.000Z",
      "metadata": {
        "version": "3.0.0",
        "environment": "production"
      }
    },
    {
      "machineId": "myia-dev-01",
      "status": "offline",
      "lastHeartbeat": "2026-01-15T22:45:00.000Z",
      "offlineSince": "2026-01-15T22:47:00.000Z"
    }
  ],
  "checkedAt": "2026-01-15T23:30:00.000Z"
}
```

---

## 🔄 Scénarios Complets

### Scénario 1 : Configuration Initiale Multi-Machine

```typescript
/**
 * Scénario : Configuration initiale d'un cluster de 3 machines
 * Objectif : Démarrer le service heartbeat sur toutes les machines
 */

async function setupHeartbeatCluster() {
  const machines = [
    { id: "myia-ai-01", role: "primary", location: "datacenter-01" },
    { id: "myia-po-2024", role: "secondary", location: "datacenter-02" },
    { id: "myia-dev-01", role: "development", location: "local" }
  ];

  const results = [];

  for (const machine of machines) {
    // 1. Enregistrer le premier heartbeat
    const heartbeatResult = await roosync_register_heartbeat({
      machineId: machine.id,
      metadata: {
        role: machine.role,
        location: machine.location,
        version: "3.0.0",
        environment: "production"
      }
    });

    // 2. Démarrer le service heartbeat
    const serviceResult = await roosync_start_heartbeat_service({
      machineId: machine.id,
      enableAutoSync: true,
      heartbeatInterval: 30000,
      offlineTimeout: 120000
    });

    results.push({
      machineId: machine.id,
      heartbeat: heartbeatResult,
      service: serviceResult
    });
  }

  // 3. Vérifier l'état global
  const state = await roosync_get_heartbeat_state({
    includeHeartbeats: true
  });

  return {
    setupResults: results,
    globalState: state
  };
}

// Exécution
const clusterSetup = await setupHeartbeatCluster();
console.log("Cluster configuré avec succès:", clusterSetup);
```

### Scénario 2 : Surveillance et Alertes Automatiques

```typescript
/**
 * Scénario : Surveillance continue avec alertes
 * Objectif : Détecter les changements de statut et envoyer des alertes
 */

class HeartbeatMonitor {
  private checkInterval: NodeJS.Timeout | null = null;
  private lastKnownState: Map<string, string> = new Map();

  async startMonitoring(intervalMs: number = 60000) {
    // Initialiser l'état
    const initialState = await roosync_get_heartbeat_state({
      includeHeartbeats: true
    });

    initialState.heartbeats.forEach((data, machineId) => {
      this.lastKnownState.set(machineId, data.status);
    });

    // Démarrer la surveillance
    this.checkInterval = setInterval(async () => {
      await this.checkAndAlert();
    }, intervalMs);

    console.log("Surveillance démarrée");
  }

  async checkAndAlert() {
    const checkResult = await roosync_check_heartbeats({
      forceCheck: true
    });

    // Alertes pour machines nouvellement offline
    for (const machineId of checkResult.newlyOfflineMachines) {
      await this.sendAlert({
        type: "OFFLINE",
        machineId,
        message: `Machine ${machineId} est devenue offline`,
        severity: "HIGH"
      });

      // Déclencher la synchronisation offline
      await roosync_sync_on_offline({
        machineId,
        createBackup: true,
        dryRun: false
      });
    }

    // Alertes pour machines redevenues online
    for (const machineId of checkResult.newlyOnlineMachines) {
      await this.sendAlert({
        type: "ONLINE",
        machineId,
        message: `Machine ${machineId} est redevenue online`,
        severity: "INFO"
      });

      // Déclencher la synchronisation online
      await roosync_sync_on_online({
        machineId,
        createBackup: true,
        dryRun: false,
        syncFromBaseline: true
      });
    }

    // Alertes pour machines en avertissement
    for (const machineId of checkResult.warningMachines) {
      const previousStatus = this.lastKnownState.get(machineId);
      if (previousStatus !== "warning") {
        await this.sendAlert({
          type: "WARNING",
          machineId,
          message: `Machine ${machineId} est en avertissement`,
          severity: "MEDIUM"
        });
      }
    }

    // Mettre à jour l'état
    const currentState = await roosync_get_heartbeat_state({
      includeHeartbeats: true
    });

    currentState.heartbeats.forEach((data, machineId) => {
      this.lastKnownState.set(machineId, data.status);
    });
  }

  async sendAlert(alert: {
    type: string;
    machineId: string;
    message: string;
    severity: string;
  }) {
    console.log(`[${alert.severity}] ${alert.type}: ${alert.message}`);

    // Envoyer via le système de messagerie RooSync
    await roosync_send_message({
      to: "admin-machine",
      subject: `[${alert.type}] Alert Heartbeat: ${alert.machineId}`,
      body: alert.message,
      priority: alert.severity as any,
      tags: ["heartbeat", "alert", alert.type.toLowerCase()]
    });
  }

  stopMonitoring() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log("Surveillance arrêtée");
    }
  }
}

// Utilisation
const monitor = new HeartbeatMonitor();
await monitor.startMonitoring(60000); // Vérification toutes les minutes
```

### Scénario 3 : Synchronisation Automatique avec Rollback

```typescript
/**
 * Scénario : Synchronisation automatique avec capacité de rollback
 * Objectif : Synchroniser les baselines lors des changements de statut
 */

class AutoSyncManager {
  async handleOfflineMachine(machineId: string) {
    console.log(`Traitement machine offline: ${machineId}`);

    // 1. Vérifier que la machine est bien offline
    const offlineMachines = await roosync_get_offline_machines({
      includeDetails: true
    });

    const machine = offlineMachines.machines.find(m => m.machineId === machineId);
    if (!machine) {
      console.log(`Machine ${machineId} n'est pas offline`);
      return;
    }

    // 2. Créer une sauvegarde avant synchronisation
    const backupPath = await this.createBackup(machineId, "offline");

    // 3. Effectuer la synchronisation offline
    const syncResult = await roosync_sync_on_offline({
      machineId,
      createBackup: true,
      dryRun: false
    });

    if (syncResult.success) {
      console.log(`Synchronisation offline réussie pour ${machineId}`);
      console.log(`Sauvegarde: ${backupPath}`);
      console.log(`Fichiers synchronisés: ${syncResult.changes.filesSynced}`);
    } else {
      console.error(`Échec de la synchronisation pour ${machineId}`);
    }
  }

  async handleOnlineMachine(machineId: string) {
    console.log(`Traitement machine online: ${machineId}`);

    // 1. Vérifier que la machine est bien online
    const state = await roosync_get_heartbeat_state({
      includeHeartbeats: true
    });

    const heartbeatData = state.heartbeats[machineId];
    if (!heartbeatData || heartbeatData.status !== "online") {
      console.log(`Machine ${machineId} n'est pas online`);
      return;
    }

    // 2. Calculer la durée offline
    let offlineDuration = 0;
    if (heartbeatData.offlineSince) {
      offlineDuration = Date.now() - new Date(heartbeatData.offlineSince).getTime();
      console.log(`Durée offline: ${Math.round(offlineDuration / 1000)}s`);
    }

    // 3. Créer une sauvegarde avant synchronisation
    const backupPath = await this.createBackup(machineId, "online");

    // 4. Effectuer la synchronisation online
    const syncResult = await roosync_sync_on_online({
      machineId,
      createBackup: true,
      dryRun: false,
      syncFromBaseline: true
    });

    if (syncResult.success) {
      console.log(`Synchronisation online réussie pour ${machineId}`);
      console.log(`Sauvegarde: ${backupPath}`);
      console.log(`Fichiers synchronisés: ${syncResult.changes.filesSynced}`);
      console.log(`Conflits résolus: ${syncResult.changes.conflictsResolved}`);
    } else {
      console.error(`Échec de la synchronisation pour ${machineId}`);
    }
  }

  async createBackup(machineId: string, type: "offline" | "online"): Promise<string> {
    const timestamp = Date.now();
    const backupPath = `roo-config/backups/${type}-sync-${machineId}-${timestamp}.json`;

    // Logique de sauvegarde réelle à implémenter
    console.log(`Sauvegarde créée: ${backupPath}`);

    return backupPath;
  }

  async rollback(machineId: string, backupPath: string) {
    console.log(`Rollback pour ${machineId} depuis ${backupPath}`);

    // Logique de rollback à implémenter
    console.log(`Rollback effectué avec succès`);
  }
}

// Utilisation avec callbacks
const syncManager = new AutoSyncManager();

await roosync_start_heartbeat_service({
  machineId: "myia-ai-01",
  enableAutoSync: true,
  heartbeatInterval: 30000,
  offlineTimeout: 120000
});

// Les callbacks seraient configurés dans le service HeartbeatService
// pour appeler automatiquement syncManager.handleOfflineMachine()
// et syncManager.handleOnlineMachine()
```

---

## 🔗 Intégration avec Autres Services

### Exemple 1 : Intégration avec le Système de Messagerie

```typescript
/**
 * Intégration : Heartbeat + Messagerie
 * Objectif : Envoyer des notifications via le système de messagerie RooSync
 */

class HeartbeatMessagingIntegration {
  async notifyOfflineMachine(machineId: string, offlineSince: string) {
    const offlineDuration = Date.now() - new Date(offlineSince).getTime();
    const durationMinutes = Math.round(offlineDuration / 60000);

    await roosync_send_message({
      to: "admin-machine",
      subject: `⚠️ Machine Offline: ${machineId}`,
      body: `La machine ${machineId} est offline depuis ${durationMinutes} minutes.

**Détails :**
- Machine ID: ${machineId}
- Offline depuis: ${offlineSince}
- Durée: ${durationMinutes} minutes

**Actions :**
- Synchronisation offline automatique déclenchée
- Sauvegarde créée avant synchronisation`,
      priority: "HIGH",
      tags: ["heartbeat", "offline", "alert"]
    });
  }

  async notifyOnlineMachine(machineId: string, offlineDuration: number) {
    const durationMinutes = Math.round(offlineDuration / 60000);

    await roosync_send_message({
      to: "admin-machine",
      subject: `✅ Machine Online: ${machineId}`,
      body: `La machine ${machineId} est redevenue online.

**Détails :**
- Machine ID: ${machineId}
- Durée offline: ${durationMinutes} minutes

**Actions :**
- Synchronisation online automatique déclenchée
- Sauvegarde créée avant synchronisation`,
      priority: "MEDIUM",
      tags: ["heartbeat", "online", "recovery"]
    });
  }

  async notifyWarningMachine(machineId: string, warningSince: string) {
    await roosync_send_message({
      to: "admin-machine",
      subject: `⚡ Machine Warning: ${machineId}`,
      body: `La machine ${machineId} est en avertissement.

**Détails :**
- Machine ID: ${machineId}
- Warning depuis: ${warningSince}

**Recommandation :**
Vérifier la connectivité de la machine.`,
      priority: "MEDIUM",
      tags: ["heartbeat", "warning", "alert"]
    });
  }
}
```

### Exemple 2 : Intégration avec la Gestion de Baseline

```typescript
/**
 * Intégration : Heartbeat + Baseline
 * Objectif : Synchroniser les baselines lors des changements de statut
 */

class HeartbeatBaselineIntegration {
  async syncBaselineOnOffline(machineId: string) {
    console.log(`Synchronisation baseline pour machine offline: ${machineId}`);

    // 1. Exporter la baseline actuelle
    const baselineExport = await roosync_export_baseline({
      format: "json",
      machineId,
      includeHistory: true,
      includeMetadata: true
    });

    // 2. Sauvegarder la baseline
    const backupPath = `roo-config/backups/baseline-${machineId}-${Date.now()}.json`;
    // Logique de sauvegarde à implémenter

    // 3. Synchroniser avec les autres machines
    await roosync_sync_on_offline({
      machineId,
      createBackup: true,
      dryRun: false
    });

    console.log(`Baseline synchronisée pour ${machineId}`);
  }

  async syncBaselineOnOnline(machineId: string) {
    console.log(`Synchronisation baseline pour machine online: ${machineId}`);

    // 1. Récupérer la baseline depuis le stockage partagé
    // Logique de récupération à implémenter

    // 2. Appliquer la baseline à la machine
    await roosync_apply_config({
      machineId,
      version: "latest",
      targets: ["modes", "mcp"],
      backup: true,
      dryRun: false
    });

    // 3. Synchroniser les changements
    await roosync_sync_on_online({
      machineId,
      createBackup: true,
      dryRun: false,
      syncFromBaseline: true
    });

    console.log(`Baseline synchronisée pour ${machineId}`);
  }
}
```

---

## 🤖 Scripts d'Automatisation

### Script 1 : Script de Démarrage Automatique

```typescript
/**
 * Script : Démarrage automatique du service heartbeat
 * Fichier : scripts/start-heartbeat-service.ts
 */

import { roosync_register_heartbeat } from '../src/tools/roosync/register-heartbeat.js';
import { roosync_start_heartbeat_service } from '../src/tools/roosync/start-heartbeat-service.js';

async function startHeartbeatService() {
  const machineId = process.env.MACHINE_ID || "unknown-machine";
  const environment = process.env.NODE_ENV || "development";

  console.log(`Démarrage du service heartbeat pour ${machineId} (${environment})`);

  try {
    // 1. Enregistrer le premier heartbeat
    const heartbeatResult = await roosync_register_heartbeat({
      machineId,
      metadata: {
        version: "3.0.0",
        environment,
        startedAt: new Date().toISOString(),
        nodeVersion: process.version,
        platform: process.platform
      }
    });

    console.log("Heartbeat enregistré:", heartbeatResult);

    // 2. Démarrer le service
    const serviceResult = await roosync_start_heartbeat_service({
      machineId,
      enableAutoSync: true,
      heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || "30000"),
      offlineTimeout: parseInt(process.env.OFFLINE_TIMEOUT || "120000")
    });

    console.log("Service démarré:", serviceResult);

    console.log("✅ Service heartbeat opérationnel");
  } catch (error) {
    console.error("❌ Erreur lors du démarrage:", error);
    process.exit(1);
  }
}

// Exécution
startHeartbeatService();
```

### Script 2 : Script de Surveillance

```typescript
/**
 * Script : Surveillance continue des heartbeats
 * Fichier : scripts/monitor-heartbeats.ts
 */

import { roosync_check_heartbeats } from '../src/tools/roosync/check-heartbeats.js';
import { roosync_get_offline_machines } from '../src/tools/roosync/get-offline-machines.js';
import { roosync_get_warning_machines } from '../src/tools/roosync/get-warning-machines.js';

async function monitorHeartbeats() {
  console.log("🔍 Surveillance des heartbeats...");

  try {
    // 1. Vérifier les heartbeats
    const checkResult = await roosync_check_heartbeats({
      forceCheck: true
    });

    console.log("📊 Résultat de la vérification:");
    console.log(`  - Machines nouvellement offline: ${checkResult.newlyOfflineMachines.length}`);
    console.log(`  - Machines redevenues online: ${checkResult.newlyOnlineMachines.length}`);
    console.log(`  - Machines en avertissement: ${checkResult.warningMachines.length}`);

    // 2. Afficher les machines offline
    if (checkResult.newlyOfflineMachines.length > 0) {
      const offlineMachines = await roosync_get_offline_machines({
        includeDetails: true
      });

      console.log("\n🔴 Machines offline:");
      for (const machine of offlineMachines.machines) {
        console.log(`  - ${machine.machineId} (depuis ${machine.offlineSince})`);
      }
    }

    // 3. Afficher les machines en avertissement
    if (checkResult.warningMachines.length > 0) {
      const warningMachines = await roosync_get_warning_machines({
        includeDetails: true
      });

      console.log("\n⚡ Machines en avertissement:");
      for (const machine of warningMachines.machines) {
        console.log(`  - ${machine.machineId} (depuis ${machine.warningSince})`);
      }
    }

    console.log("\n✅ Surveillance terminée");
  } catch (error) {
    console.error("❌ Erreur lors de la surveillance:", error);
  }
}

// Exécution
monitorHeartbeats();
```

### Script 3 : Script de Rapport Quotidien

```typescript
/**
 * Script : Génération de rapport quotidien
 * Fichier : scripts/daily-heartbeat-report.ts
 */

import { roosync_get_heartbeat_state } from '../src/tools/roosync/get-heartbeat-state.js';

async function generateDailyReport() {
  console.log("📊 Génération du rapport quotidien...");

  try {
    const state = await roosync_get_heartbeat_state({
      includeHeartbeats: true
    });

    const report = {
      date: new Date().toISOString(),
      summary: {
        total: state.statistics.totalMachines,
        online: state.statistics.onlineCount,
        offline: state.statistics.offlineCount,
        warning: state.statistics.warningCount
      },
      machines: []
    };

    for (const [machineId, data] of Object.entries(state.heartbeats)) {
      report.machines.push({
        machineId,
        status: data.status,
        lastHeartbeat: data.lastHeartbeat,
        offlineSince: data.offlineSince,
        warningSince: data.warningSince
      });
    }

    console.log("\n📋 Rapport Quotidien:");
    console.log(`Date: ${report.date}`);
    console.log(`Total: ${report.summary.total}`);
    console.log(`🟢 Online: ${report.summary.online}`);
    console.log(`🔴 Offline: ${report.summary.offline}`);
    console.log(`⚡ Warning: ${report.summary.warning}`);

    console.log("\nDétail par machine:");
    for (const machine of report.machines) {
      const icon = machine.status === "online" ? "🟢" :
                   machine.status === "offline" ? "🔴" : "⚡";
      console.log(`  ${icon} ${machine.machineId}: ${machine.status}`);
    }

    // Sauvegarder le rapport
    const reportPath = `roo-config/reports/heartbeat-report-${Date.now()}.json`;
    // Logique de sauvegarde à implémenter

    console.log(`\n✅ Rapport sauvegardé: ${reportPath}`);
  } catch (error) {
    console.error("❌ Erreur lors de la génération du rapport:", error);
  }
}

// Exécution
generateDailyReport();
```

---

## 🚀 Cas d'Usage Avancés

### Cas 1 : Gestion de Pannes en Cascade

```typescript
/**
 * Cas d'usage : Gestion de pannes en cascade
 * Objectif : Détecter et gérer les pannes multiples
 */

class CascadeFailureManager {
  private failureThreshold = 3; // Nombre de machines offline avant alerte critique
  private recentFailures: string[] = [];

  async handleOfflineMachine(machineId: string) {
    this.recentFailures.push(machineId);

    // Vérifier si nous avons atteint le seuil de panne en cascade
    if (this.recentFailures.length >= this.failureThreshold) {
      await this.handleCascadeFailure();
    }
  }

  async handleCascadeFailure() {
    console.log("⚠️ PANNE EN CASCADE DÉTECTÉE");

    // 1. Envoyer une alerte critique
    await roosync_send_message({
      to: "admin-machine",
      subject: "🚨 PANNE EN CASCADE DÉTECTÉE",
      body: `Plusieurs machines sont devenues offline récemment:

${this.recentFailures.map(id => `- ${id}`).join('\n')}

**Action requise :**
Vérifier l'infrastructure réseau et les services critiques.`,
      priority: "URGENT",
      tags: ["heartbeat", "cascade", "critical"]
    });

    // 2. Arrêter la synchronisation automatique pour éviter les conflits
    await roosync_stop_heartbeat_service({
      saveState: true
    });

    // 3. Créer un rapport d'incident
    await this.createIncidentReport();
  }

  async createIncidentReport() {
    const state = await roosync_get_heartbeat_state({
      includeHeartbeats: true
    });

    const report = {
      incidentType: "CASCADE_FAILURE",
      timestamp: new Date().toISOString(),
      affectedMachines: this.recentFailures,
      systemState: state
    };

    const reportPath = `roo-config/incidents/cascade-${Date.now()}.json`;
    // Logique de sauvegarde à implémenter

    console.log(`Rapport d'incident créé: ${reportPath}`);
  }

  resetFailures() {
    this.recentFailures = [];
  }
}
```

### Cas 2 : Équilibrage de Charge Dynamique

```typescript
/**
 * Cas d'usage : Équilibrage de charge dynamique
 * Objectif : Rediriger le trafic vers les machines disponibles
 */

class LoadBalancer {
  async getAvailableMachines(): Promise<string[]> {
    const state = await roosync_get_heartbeat_state({
      includeHeartbeats: true
    });

    return state.onlineMachines;
  }

  async distributeTask(task: any): Promise<string> {
    const availableMachines = await this.getAvailableMachines();

    if (availableMachines.length === 0) {
      throw new Error("Aucune machine disponible");
    }

    // Sélectionner une machine aléatoire parmi les disponibles
    const selectedMachine = availableMachines[
      Math.floor(Math.random() * availableMachines.length)
    ];

    console.log(`Tâche distribuée vers ${selectedMachine}`);

    return selectedMachine;
  }

  async getMachineLoad(machineId: string): Promise<number> {
    const state = await roosync_get_heartbeat_state({
      includeHeartbeats: true
    });

    const heartbeatData = state.heartbeats[machineId];
    if (!heartbeatData || !heartbeatData.metadata) {
      return 0;
    }

    // Utiliser les métadonnées pour estimer la charge
    return heartbeatData.metadata.cpuUsage || 0;
  }

  async selectLeastLoadedMachine(): Promise<string> {
    const availableMachines = await this.getAvailableMachines();

    if (availableMachines.length === 0) {
      throw new Error("Aucune machine disponible");
    }

    let leastLoadedMachine = availableMachines[0];
    let lowestLoad = await this.getMachineLoad(leastLoadedMachine);

    for (const machineId of availableMachines) {
      const load = await this.getMachineLoad(machineId);
      if (load < lowestLoad) {
        lowestLoad = load;
        leastLoadedMachine = machineId;
      }
    }

    return leastLoadedMachine;
  }
}
```

### Cas 3 : Maintenance Planifiée

```typescript
/**
 * Cas d'usage : Maintenance planifiée
 * Objectif : Gérer les périodes de maintenance sans fausses alertes
 */

class MaintenanceManager {
  private maintenanceSchedule: Map<string, { start: Date; end: Date }> = new Map();

  scheduleMaintenance(machineId: string, start: Date, end: Date) {
    this.maintenanceSchedule.set(machineId, { start, end });
    console.log(`Maintenance planifiée pour ${machineId}: ${start} à ${end}`);
  }

  isInMaintenance(machineId: string): boolean {
    const schedule = this.maintenanceSchedule.get(machineId);
    if (!schedule) {
      return false;
    }

    const now = new Date();
    return now >= schedule.start && now <= schedule.end;
  }

  async handleOfflineMachine(machineId: string) {
    // Vérifier si la machine est en maintenance
    if (this.isInMaintenance(machineId)) {
      console.log(`Machine ${machineId} en maintenance - ignorée`);
      return;
    }

    // Traitement normal
    console.log(`Machine ${machineId} offline - traitement en cours`);
    await roosync_sync_on_offline({
      machineId,
      createBackup: true,
      dryRun: false
    });
  }

  async handleOnlineMachine(machineId: string) {
    // Vérifier si la maintenance est terminée
    const schedule = this.maintenanceSchedule.get(machineId);
    if (schedule && new Date() > schedule.end) {
      console.log(`Maintenance terminée pour ${machineId}`);
      this.maintenanceSchedule.delete(machineId);
    }

    // Traitement normal
    console.log(`Machine ${machineId} online - traitement en cours`);
    await roosync_sync_on_online({
      machineId,
      createBackup: true,
      dryRun: false,
      syncFromBaseline: true
    });
  }
}

// Exemple d'utilisation
const maintenanceManager = new MaintenanceManager();

// Planifier une maintenance pour demain de 2h à 4h
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
tomorrow.setHours(2, 0, 0, 0);

const endOfMaintenance = new Date(tomorrow);
endOfMaintenance.setHours(4, 0, 0, 0);

maintenanceManager.scheduleMaintenance("myia-po-2024", tomorrow, endOfMaintenance);
```

---

## 📝 Résumé

Ce document fournit des exemples complets et concrets pour l'utilisation des outils MCP Heartbeat dans différents scénarios :

- **Exemples de base** : Utilisation simple des outils
- **Scénarios complets** : Workflows complexes et intégrations
- **Intégration avec autres services** : Messagerie, Baseline
- **Scripts d'automatisation** : Démarrage, surveillance, rapports
- **Cas d'usage avancés** : Pannes en cascade, équilibrage de charge, maintenance

Pour plus d'informations, consultez le [Guide Utilisateur](HEARTBEAT-USAGE.md).

---

*Documentation générée le 2026-01-15 - Version 3.0.0*
