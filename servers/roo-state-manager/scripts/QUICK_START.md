# 🚀 Démarrage Rapide - Scripts Consolidés roo-state-manager

## 🎯 OBJECTIF PRINCIPAL

**Lancer les tests unitaires en une seule commande simple et mémorable**

---

## 🧪 COMMANDE SPÉCIFIQUE POUR LES TESTS UNITAIRES

### ✅ LA COMMANDE LA PLUS SIMPLE

```powershell
# Depuis le répertoire scripts/
.\roo.ps1 test unit
```

### 🔄 Équivalences directes

| Ancienne commande | Nouvelle commande | Recommandation |
|----------------|------------------|-----------------|
| `.\run-tests.ps1` | `.\roo.ps1 test unit` | ✅ Utiliser la nouvelle |
| `.\run-tests-simple.ps1` | `.\roo.ps1 test unit` | ✅ Utiliser la nouvelle |
| `.\consolidated\roo-tests.ps1 -Type unit` | `.\roo.ps1 test unit` | ✅ Plus simple |

---

## 🚀 Workflows Essentiels

### 🧪 Tests Unitaires (LE PLUS IMPORTANT)

```powershell
# Commande SPÉCIFIQUE et MÉMORABLE
.\roo.ps1 test unit

# Avec détails
.\roo.ps1 test unit -verbose

# Rapport JSON
.\roo.ps1 test unit -quiet
```

### 🚀 Déploiement Complet

```powershell
# Installation et déploiement
.\roo.ps1 deploy

# Force le déploiement
.\roo.ps1 deploy -force
```

### 🔍 Diagnostic Complet

```powershell
# Diagnostic système
.\roo.ps1 diagnose

# Diagnostic du cache
.\roo.ps1 diagnose cache

# Diagnostic détaillé
.\roo.ps1 diagnose -verbose
```

### 💾 Gestion du Cache

```powershell
# Construire le cache
.\roo.ps1 cache build

# Forcer la reconstruction
.\roo.ps1 cache build -force

# Valider le cache
.\roo.ps1 cache validate
```

---

## 📋 Référence Rapide

### Commandes de base

| Action | Commande | Description |
|--------|----------|-------------|
| **Tests unitaires** | `.\roo.ps1 test unit` | **LA PLUS IMPORTANTE** |
| Tests complets | `.\roo.ps1 test all` | Tous les types de tests |
| Déploiement | `.\roo.ps1 deploy` | Installation complète |
| Diagnostic | `.\roo.ps1 diagnose` | État système complet |
| Cache | `.\roo.ps1 cache build` | Construire le cache |
| Aide | `.\roo.ps1 help` | Afficher l'aide |

### Options utiles

| Option | Usage | Description |
|--------|--------|-------------|
| `-verbose` | `.\roo.ps1 test unit -verbose` | Logging détaillé |
| `-force` | `.\roo.ps1 cache build -force` | Forcer l'action |
| `-quiet` | `.\roo.ps1 test unit -quiet` | Sortie minimale |

---

## 🎯 Scenarios Courants

### 📝 Développeur Quotidien

```powershell
# 1. Lancer les tests unitaires (PLUS FRÉQUENT)
.\roo.ps1 test unit

# 2. Si problèmes, diagnostic rapide
.\roo.ps1 diagnose

# 3. Reconstruire le cache si nécessaire
.\roo.ps1 cache build -force
```

### 🚀 Déploiement en Production

```powershell
# 1. Déploiement complet
.\roo.ps1 deploy

# 2. Validation des tests
.\roo.ps1 test all

# 3. Diagnostic final
.\roo.ps1 diagnose system
```

### 🔍 Résolution de Problèmes

```powershell
# 1. Diagnostic complet
.\roo.ps1 diagnose -verbose

# 2. Tests détaillés
.\roo.ps1 test unit -verbose

# 3. Cache propre
.\roo.ps1 cache clean
.\roo.ps1 cache build -force
```

---

## 🆘 Aide Rapide

### Obtenir de l'aide

```powershell
# Aide générale
.\roo.ps1 help

# Version
.\roo.ps1 version

# Aide détaillée des scripts
.\consolidated\roo-tests.ps1 -Help
```

### Problèmes courants

| Problème | Solution |
|----------|----------|
| "Commande non trouvée" | `Set-Location scripts\` puis `.\roo.ps1 test unit` |
| "Tests échouent" | `.\roo.ps1 diagnose cache` puis `.\roo.ps1 cache build -force` |
| "Déploiement échoue" | `.\roo.ps1 deploy -force -verbose` |

---

## 📊 Avantages des Nouveaux Scripts

### ✅ Pour les développeurs

- **1 seule commande** à mémoriser pour les tests unitaires
- **90% moins de scripts** à gérer
- **Interface unifiée** pour toutes les opérations
- **Aide intégrée** avec `.\roo.ps1 help`

### ✅ Pour l'équipe

- **Formation simplifiée** : une seule commande à apprendre
- **Documentation centralisée** : ce fichier QUICK_START.md
- **Support unifié** : mêmes options sur tous les scripts

---

## 🎯 Conclusion

### 🏆 LA COMMANDE À RETENIR

```powershell
.\roo.ps1 test unit
```

Cette commande remplace 4 anciens scripts et fournit :
- ✅ Tests unitaires complets
- ✅ Logging structuré
- ✅ Gestion d'erreurs
- ✅ Extensibilité future

### 📚 Documentation complète

- **Guide complet** : `README.md`
- **Migration** : `MIGRATION_GUIDE.md`
- **Démarrage rapide** : `QUICK_START.md` (ce fichier)

---

**Dernière mise à jour** : 06/11/2025  
**Version** : 1.0.0  
**Statut** : Production ✅

---

## 🎉 Félicitations !

Vous avez maintenant accès à des scripts consolidés puissants et simples. 

**La commande la plus importante :**
```powershell
.\roo.ps1 test unit
```

**Utilisez-la, mémorisez-la, partagez-la !** 🚀