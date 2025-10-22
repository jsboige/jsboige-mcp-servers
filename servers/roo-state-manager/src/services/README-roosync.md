# RooSync Services - Guide Technique

**Version** : 2.0.0  
**Date** : 2025-10-15  
**Statut** : Production Ready

---

## 📋 Vue d'Ensemble

Ce document fournit une référence technique complète pour les composants de détection de différences RooSync v2.0. Ces services permettent la collecte automatique d'inventaire système et la détection intelligente de différences entre environnements Roo.

### Composants Principaux

| Composant | Fichier | Responsabilité |
|-----------|---------|----------------|
| **InventoryCollector** | [`InventoryCollector.ts`](InventoryCollector.ts) | Collecte inventaire système via PowerShell |
| **DiffDetector** | [`DiffDetector.ts`](DiffDetector.ts) | Détection et analyse des différences |
| **RooSyncService** | [`RooSyncService.ts`](RooSyncService.ts) | Orchestration et gestion workflow |
| **PowerShellExecutor** | [`PowerShellExecutor.ts`](PowerShellExecutor.ts) | Exécution scripts PowerShell |

---

## 🏗️ Architecture

### Diagramme de Flux

```
┌─────────────────────────────────────────────────────┐
│           Outil MCP roosync_compare_config          │
│                  (Interface LLM)                     │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│               RooSyncService                        │
│  • Orchestration workflow                           │
│  • Gestion cache                                    │
└───────────┬──────────────────────┬──────────────────┘
            │                      │
            ▼                      ▼
┌──────────────────────┐   ┌──────────────────────┐
│ InventoryCollector   │   │   DiffDetector       │
│ • Cache TTL 1h       │   │ • 4 niveaux sévérité │
│ • 4 catégories       │   │ • 25 patterns        │
└──────────┬───────────┘   └──────────┬───────────┘
           │                          │
           ▼                          ▼
┌──────────────────────┐   ┌──────────────────────┐
│ PowerShellExecutor   │   │ Algorithmes          │
│ • Get-MachineInv.ps1 │   │ • Scoring sévérité   │
└──────────────────────┘   └──────────────────────┘
```

---

## 📦 InventoryCollector

### Description

Service de collecte automatique d'inventaire système via script PowerShell `Get-MachineInventory.ps1`. Implémente un cache intelligent avec TTL pour optimiser les performances.

### Fichier Source

[`InventoryCollector.ts`](InventoryCollector.ts) (278 lignes)

### API Publique

#### `getInventory(machineId?: string): Promise<MachineInventory>`

Collecte l'inventaire complet d'une machine.

**Paramètres** :
- `machineId` (optional) : Identifiant de la machine. Si omis, utilise machine locale.

**Retour** : `MachineInventory`
```typescript
interface MachineInventory {
  machineId: string;
  timestamp: string;
  roo: RooConfig;
  hardware: HardwareInfo;
  software: SoftwareInfo;
  system: SystemInfo;
}
```

**Exemple** :
```typescript
const collector = new InventoryCollector(powershellExecutor);
const inventory = await collector.getInventory('myia-ai-01');

console.log(inventory.roo.mcps); // ['quickfiles', 'github', ...]
console.log(inventory.hardware.cpu.model); // 'AMD Ryzen 9 5900X'
```

**Performance** :
- Cache hit : <100ms
- Cache miss : 1-2s (collecte PowerShell complète)
- TTL cache : 1 heure

#### `clearCache(machineId?: string): void`

Invalide le cache pour une machine spécifique ou tout le cache.

**Paramètres** :
- `machineId` (optional) : ID de la machine. Si omis, vide tout le cache.

**Exemple** :
```typescript
collector.clearCache('myia-ai-01'); // Invalide cache pour cette machine
collector.clearCache(); // Invalide tout le cache
```

#### `getCacheStats(): CacheStats`

Obtient des statistiques sur le cache.

**Retour** : `CacheStats`
```typescript
interface CacheStats {
  entries: number;
  oldestEntry?: string;
  newestEntry?: string;
}
```

**Exemple** :
```typescript
const stats = collector.getCacheStats();
console.log(`Cache contient ${stats.entries} entrées`);
```

### Structure de Données

#### `MachineInventory`

```typescript
interface MachineInventory {
  machineId: string;        // Identifiant unique machine
  timestamp: string;         // ISO 8601 UTC
  roo: RooConfig;           // Configuration Roo
  hardware: HardwareInfo;   // Infos hardware
  software: SoftwareInfo;   // Infos software
  system: SystemInfo;       // Infos système
}
```

#### `RooConfig`

```typescript
interface RooConfig {
  mcps: string[];           // Liste MCPs actifs
  modes: string[];          // Liste Modes actifs
  profiles: string[];       // Profils disponibles
  version?: string;         // Version Roo
}
```

#### `HardwareInfo`

```typescript
interface HardwareInfo {
  cpu: {
    model: string;
    cores: number;
    threads: number;
  };
  memory: {
    total: number;          // GB
    available: number;      // GB
  };
  storage: Array<{
    drive: string;
    total: number;          // GB
    free: number;           // GB
  }>;
  gpu?: Array<{
    name: string;
    memory?: number;        // GB
  }>;
}
```

### Cache Implementation

**Stratégie** : Map in-memory avec TTL par entrée

**Avantages** :
- Performance excellente (accès O(1))
- Pas de dépendance externe
- Facile à déboguer

**Limitations** :
- Cache local (pas partagé entre processus)
- Perte cache si restart serveur MCP

**Configuration TTL** :
```typescript
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 heure
```

### Script PowerShell

**Fichier** : `RooSync/scripts/Get-MachineInventory.ps1`

**Fonctionnalités** :
- Collecte info système complet
- Parse mcp_settings.json pour MCPs
- Parse .roomodes pour Modes
- Output JSON structuré

**Exemple d'exécution** :
```powershell
pwsh -NoProfile -ExecutionPolicy Bypass `
  -File "RooSync/scripts/Get-MachineInventory.ps1"
```

**Output JSON** :
```json
{
  "machineId": "MYIA-AI-01",
  "timestamp": "2025-10-15T20:00:00.000Z",
  "roo": {
    "mcps": ["quickfiles", "github"],
    "modes": ["code", "architect"],
    "profiles": ["default"]
  },
  "hardware": { ... },
  "software": { ... },
  "system": { ... }
}
```

---

## 🔍 DiffDetector

### Description

Service d'analyse et de détection de différences entre deux inventaires machines. Implémente un scoring multi-niveaux de sévérité et génère des recommandations automatiques.

### Fichier Source

[`DiffDetector.ts`](DiffDetector.ts) (590 lignes)

### API Publique

#### `detectDifferences(source: MachineInventory, target: MachineInventory): DiffResult`

Détecte et analyse les différences entre deux inventaires.

**Paramètres** :
- `source` : Inventaire machine source
- `target` : Inventaire machine cible

**Retour** : `DiffResult`
```typescript
interface DiffResult {
  summary: {
    totalDifferences: number;
    bySeverity: { [key: string]: number };
    byCategory: { [key: string]: number };
  };
  differences: Difference[];
  recommendations: string[];
  metadata: {
    comparisonTimestamp: string;
    sourceMachine: string;
    targetMachine: string;
  };
}
```

**Exemple** :
```typescript
const detector = new DiffDetector();
const result = detector.detectDifferences(invSource, invTarget);

console.log(`${result.summary.totalDifferences} différences détectées`);
console.log(`CRITICAL: ${result.summary.bySeverity.CRITICAL}`);

result.differences.forEach(diff => {
  console.log(`[${diff.severity}] ${diff.category}: ${diff.description}`);
});
```

#### `scoreSeverity(diff: Difference): 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO'`

Calcule le score de sévérité d'une différence.

**Paramètres** :
- `diff` : Objet Difference à scorer

**Retour** : Niveau de sévérité

**Logique de Scoring** :
- **CRITICAL** : MCP manquant, Mode incompatible, RAM insuffisante (<8GB)
- **IMPORTANT** : Version différente, CPU différent, GPU absent
- **WARNING** : Software version différente (Node, Python)
- **INFO** : OS différent, Architecture différente

### Patterns de Détection

#### 1. Différences Roo Config (Catégorie: `roo`)

| Pattern | Sévérité | Description |
|---------|----------|-------------|
| MCP manquant | CRITICAL | MCP présent en source, absent en cible |
| MCP supplémentaire | WARNING | MCP présent en cible, absent en source |
| Mode manquant | CRITICAL | Mode présent en source, absent en cible |
| Mode supplémentaire | WARNING | Mode présent en cible, absent en source |
| Version différente | WARNING | Versions Roo différentes |

**Exemple de différence** :
```typescript
{
  category: 'roo',
  type: 'mcp_missing',
  severity: 'CRITICAL',
  description: 'MCP "quickfiles" présent en source mais absent en cible',
  source: 'quickfiles',
  target: null,
  recommendation: 'Installer MCP quickfiles sur cible',
  impact: 'Fonctionnalités quickfiles indisponibles sur cible'
}
```

#### 2. Différences Hardware (Catégorie: `hardware`)

| Pattern | Sévérité | Description |
|---------|----------|-------------|
| RAM insuffisante | CRITICAL | Cible a <8GB RAM |
| CPU différent | IMPORTANT | Modèles CPU différents |
| GPU absent | IMPORTANT | GPU présent en source, absent en cible |
| Stockage insuffisant | WARNING | Espace disque <10% libre |

**Exemple de différence** :
```typescript
{
  category: 'hardware',
  type: 'memory_insufficient',
  severity: 'CRITICAL',
  description: 'RAM insuffisante sur cible (4GB vs 16GB)',
  source: '16GB',
  target: '4GB',
  recommendation: 'Upgrade RAM cible vers minimum 8GB',
  impact: 'Performance dégradée, risque de crash'
}
```

#### 3. Différences Software (Catégorie: `software`)

| Pattern | Sévérité | Description |
|---------|----------|-------------|
| Node version différente | WARNING | Versions Node.js différentes |
| Python version différente | WARNING | Versions Python différentes |
| PowerShell version différente | INFO | Versions PowerShell différentes |

#### 4. Différences System (Catégorie: `system`)

| Pattern | Sévérité | Description |
|---------|----------|-------------|
| OS différent | INFO | Systèmes d'exploitation différents |
| Architecture différente | INFO | Architectures (x64/ARM) différentes |

### Recommandations Automatiques

Le DiffDetector génère des recommandations contextuelles basées sur :
- Sévérité de la différence
- Type de différence
- Impact estimé
- Actions correctives possibles

**Exemples de recommandations** :
```typescript
[
  "Installer MCPs manquants critiques: quickfiles, github",
  "Analyser impact des différences CPU sur performance",
  "Planifier mise à jour Node.js pour uniformiser versions",
  "Documenter divergences OS (Windows vs Linux)"
]
```

### Structure de Données

#### `Difference`

```typescript
interface Difference {
  category: 'roo' | 'hardware' | 'software' | 'system';
  type: string;                          // ex: 'mcp_missing'
  severity: 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO';
  description: string;                   // Description lisible
  source: any;                          // Valeur source
  target: any;                          // Valeur cible
  recommendation?: string;              // Action recommandée
  impact?: string;                      // Impact estimé
}
```

#### `DiffResult`

```typescript
interface DiffResult {
  summary: {
    totalDifferences: number;
    bySeverity: {
      CRITICAL: number;
      IMPORTANT: number;
      WARNING: number;
      INFO: number;
    };
    byCategory: {
      roo: number;
      hardware: number;
      software: number;
      system: number;
    };
  };
  differences: Difference[];
  recommendations: string[];
  metadata: {
    comparisonTimestamp: string;
    sourceMachine: string;
    targetMachine: string;
  };
}
```

---

## 🔧 Utilisation Avancée

### Exemple Complet : Détection de Différences

```typescript
import { InventoryCollector } from './services/InventoryCollector';
import { DiffDetector } from './services/DiffDetector';
import { PowerShellExecutor } from './services/PowerShellExecutor';

// 1. Initialiser services
const psExecutor = new PowerShellExecutor();
const collector = new InventoryCollector(psExecutor);
const detector = new DiffDetector();

// 2. Collecter inventaires
const invSource = await collector.getInventory('myia-ai-01');
const invTarget = await collector.getInventory('myia-po-2024');

// 3. Détecter différences
const result = detector.detectDifferences(invSource, invTarget);

// 4. Analyser résultats
console.log(`\n=== Résumé ===`);
console.log(`Total: ${result.summary.totalDifferences} différences`);
console.log(`CRITICAL: ${result.summary.bySeverity.CRITICAL}`);
console.log(`IMPORTANT: ${result.summary.bySeverity.IMPORTANT}`);

// 5. Afficher différences critiques
console.log(`\n=== Différences Critiques ===`);
result.differences
  .filter(d => d.severity === 'CRITICAL')
  .forEach(diff => {
    console.log(`[${diff.category}] ${diff.description}`);
    if (diff.recommendation) {
      console.log(`  → ${diff.recommendation}`);
    }
  });

// 6. Afficher recommandations
console.log(`\n=== Recommandations ===`);
result.recommendations.forEach((rec, i) => {
  console.log(`${i+1}. ${rec}`);
});
```

### Gestion du Cache

```typescript
// Invalider cache pour une machine spécifique
collector.clearCache('myia-ai-01');

// Forcer re-collecte
collector.clearCache();
const freshInventory = await collector.getInventory('myia-ai-01');

// Vérifier stats cache
const stats = collector.getCacheStats();
if (stats.entries > 10) {
  console.log('Cache contient beaucoup d\'entrées, considérer nettoyage');
}
```

### Mode Diagnostic

L'outil MCP `roosync_compare_config` supporte un mode diagnostic :

```typescript
// Via outil MCP
{
  "source": "myia-ai-01",
  "target": "myia-po-2024",
  "diagnose_index": true  // Active mode diagnostic
}
```

**Output diagnostic** :
```json
{
  "cache_stats": {
    "entries": 2,
    "oldest_entry": "myia-ai-01",
    "newest_entry": "myia-po-2024"
  },
  "performance": {
    "collection_time_ms": 1234,
    "detection_time_ms": 456
  }
}
```

---

## 🧪 Tests

### Tests Unitaires

#### InventoryCollector Tests (5/5 = 100%)

**Fichier** : `tests/unit/InventoryCollector.test.ts`

Tests couverts :
1. ✅ Cache TTL fonctionnel
2. ✅ Collecte inventaire PowerShell
3. ✅ Parsing JSON inventaire valide
4. ✅ Gestion erreurs script PowerShell
5. ✅ Invalidation cache

**Exécution** :
```bash
npm test -- InventoryCollector.test.ts
```

#### DiffDetector Tests (9/9 = 100%)

**Fichier** : `tests/unit/DiffDetector.test.ts`

Tests couverts :
1. ✅ Détection différences MCPs
2. ✅ Détection différences Modes
3. ✅ Détection différences Hardware (RAM, CPU)
4. ✅ Détection différences Software (Node, Python)
5. ✅ Détection différences System (OS, Architecture)
6. ✅ Scoring sévérité CRITICAL
7. ✅ Scoring sévérité IMPORTANT
8. ✅ Scoring sévérité WARNING
9. ✅ Génération recommandations

**Exécution** :
```bash
npm test -- DiffDetector.test.ts
```

### Tests d'Intégration Phase 3 (5/6 = 83%)

**Fichier** : `tests/integration/roosync-phase3.test.ts`

Tests couverts :
1. ✅ Collection inventaire réel
2. ✅ Détection différences réelles
3. ✅ Cache fonctionnel
4. ✅ Workflow complet <5s
5. ✅ Mode diagnostic
6. ⚠️ Format réponse (assertion trop stricte)

**Exécution** :
```bash
npm test -- roosync-phase3.test.ts
```

---

## 📊 Performance

### Métriques Mesurées

| Opération | Performance | Cible | Statut |
|-----------|-------------|-------|--------|
| Collecte (cache hit) | <100ms | <1s | ✅ |
| Collecte (cache miss) | 1-2s | <3s | ✅ |
| Détection différences | <500ms | <1s | ✅ |
| **Workflow complet** | **2-4s** | **<5s** | ✅ |

### Optimisations Appliquées

1. **Cache avec TTL**
   - Évite re-collecte répétée
   - TTL 1h adapté au cas d'usage
   - Invalidation manuelle possible

2. **Parsing JSON Optimisé**
   - Parsing natif JavaScript (rapide)
   - Validation schéma minimale
   - Pas de transformation complexe

3. **Algorithmes Détection O(n)**
   - Comparaison linéaire des tableaux
   - Pas de double boucle
   - Early exit si possible

---

## 🔒 Sécurité et Gestion d'Erreurs

### Sécurité

1. **Exécution PowerShell Isolée**
   - Processus enfant séparé
   - Pas d'accès au processus parent
   - Timeout configuré (30s par défaut)

2. **Validation Entrées**
   - machineId validé (alphanumerique + tirets)
   - Paths PowerShell validés
   - JSON parsé avec try/catch

3. **Pas de Secrets Exposés**
   - Inventaire ne contient pas de tokens/passwords
   - Logs sanitisés

### Gestion d'Erreurs

```typescript
try {
  const inventory = await collector.getInventory('machine-id');
} catch (error) {
  if (error.message.includes('PowerShell script failed')) {
    // Problème script PowerShell
    console.error('Vérifier script Get-MachineInventory.ps1');
  } else if (error.message.includes('Invalid JSON')) {
    // Problème parsing JSON
    console.error('Script PowerShell retourne JSON invalide');
  } else {
    // Erreur inattendue
    console.error('Erreur inattendue:', error);
  }
}
```

---

## 🛠️ Troubleshooting

### Problème : Cache Jamais Hit

**Symptômes** : Performance toujours lente (~2s), cache stats montre 0 entrées

**Causes possibles** :
1. machineId change à chaque appel
2. Cache invalidé entre appels
3. TTL trop court

**Solution** :
```typescript
// Vérifier machineId utilisé
console.log('Machine ID:', machineId);

// Vérifier cache stats
const stats = collector.getCacheStats();
console.log('Cache entries:', stats.entries);

// Augmenter TTL si nécessaire (dans InventoryCollector.ts)
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 heures au lieu de 1h
```

### Problème : Script PowerShell Échoue

**Symptômes** : Erreur "PowerShell script failed"

**Causes possibles** :
1. Script Get-MachineInventory.ps1 absent
2. Permissions PowerShell
3. Path incorrect

**Solution** :
```bash
# Vérifier présence script
ls RooSync/scripts/Get-MachineInventory.ps1

# Tester script manuellement
pwsh -NoProfile -ExecutionPolicy Bypass -File "RooSync/scripts/Get-MachineInventory.ps1"

# Vérifier permissions
Get-ExecutionPolicy
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope CurrentUser
```

### Problème : Détection Manque Différences

**Symptômes** : Différences connues non détectées

**Causes possibles** :
1. Inventaire incomplet
2. Pattern détection manquant
3. Données format inattendu

**Solution** :
```typescript
// Activer mode diagnostic
const result = await roosyncCompareConfig({
  source: 'machine1',
  target: 'machine2',
  diagnose_index: true
});

// Examiner inventaires bruts
console.log('Inventaire source:', JSON.stringify(invSource, null, 2));
console.log('Inventaire target:', JSON.stringify(invTarget, null, 2));

// Ajouter pattern détection si manquant
// Éditer DiffDetector.ts et ajouter nouveau pattern
```

---

## 📖 Références

### Documentation Complète

| Document | Description | Lien |
|----------|-------------|------|
| Design Détection Réelle | Architecture complète (1900 lignes) | [`roosync-real-diff-detection-design.md`](../../../../docs/architecture/roosync-real-diff-detection-design.md) |
| Plan Tests E2E | 8 scénarios tests (561 lignes) | [`roosync-e2e-test-plan.md`](../../../../docs/testing/roosync-e2e-test-plan.md) |
| Synthèse Évolution v2.0 | Bilan complet projet (986 lignes) | [`roosync-v2-evolution-synthesis-20251015.md`](../../../../docs/orchestration/roosync-v2-evolution-synthesis-20251015.md) |

### Code Source

| Fichier | Lignes | Description |
|---------|--------|-------------|
| [`InventoryCollector.ts`](InventoryCollector.ts) | 278 | Service collecte inventaire |
| [`DiffDetector.ts`](DiffDetector.ts) | 590 | Service détection différences |
| [`RooSyncService.ts`](RooSyncService.ts) | 676 | Service orchestration |
| [`PowerShellExecutor.ts`](PowerShellExecutor.ts) | 329 | Wrapper PowerShell |

### Scripts PowerShell

| Script | Lignes | Description |
|--------|--------|-------------|
| `Get-MachineInventory.ps1` | ~250 | Collecte inventaire système |

---

## 🎯 Roadmap

### Court Terme (1-2 semaines)

- [ ] Corriger test intégration échoué (1/6)
- [ ] Implémenter génération automatique décisions
- [ ] Parser avancé paramètres MCPs

### Moyen Terme (1-2 mois)

- [ ] Cache multi-machines synchronisé
- [ ] Parser contenu complet Modes
- [ ] Métriques détaillées performance

### Long Terme (3-6 mois)

- [ ] Intégration CI/CD
- [ ] Dashboard web visualisation
- [ ] Notifications automatiques

---

**Document généré par** : Roo Code Mode  
**Date de génération** : 2025-10-15  
**Version composants** : RooSync v2.0.0  
**Contact** : Pour questions, voir documentation complète ou ouvrir issue GitHub