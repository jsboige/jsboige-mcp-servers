# 🔄 RooSync System

**Version** : 3.0.0 (Heartbeat + Messaging)
**Status** : ✅ Production Ready
**Date** : 15 janvier 2026

## 🎯 Vue d'Ensemble

Le système RooSync fournit deux composants principaux pour la synchronisation multi-agent :

1. **💓 Heartbeat System** : Surveillance de la disponibilité des machines et synchronisation automatique
2. **📨 Messaging System** : Échange de messages structurés entre machines

Les deux systèmes utilisent un répertoire partagé (Google Drive) avec des fichiers JSON pour la persistence et des outils MCP pour l'interaction.

## 🚀 Fonctionnalités

### 💓 Heartbeat System (v3.0.0)
- ✅ **roosync_register_heartbeat** : Enregistre un heartbeat pour une machine
- ✅ **roosync_get_offline_machines** : Liste les machines offline
- ✅ **roosync_get_warning_machines** : Liste les machines en avertissement
- ✅ **roosync_get_heartbeat_state** : État complet du service heartbeat
- ✅ **roosync_start_heartbeat_service** : Démarre le service automatique
- ✅ **roosync_stop_heartbeat_service** : Arrête le service automatique
- ✅ **roosync_check_heartbeats** : Vérifie et détecte les changements
- ✅ **roosync_sync_on_offline** : Synchronise lors de la détection offline
- ✅ **roosync_sync_on_online** : Synchronise lors du retour online

### 📨 Messaging System (v2.0)
#### Phase 1 - Core Tools
- ✅ **roosync_send_message** : Envoi messages structurés avec métadonnées
- ✅ **roosync_read_inbox** : Lecture boîte de réception avec filtrage
- ✅ **roosync_get_message** : Lecture message complet avec formatage

#### Phase 2 - Management Tools
- ✅ **roosync_mark_message_read** : Marquer messages comme lus
- ✅ **roosync_archive_message** : Archiver messages (déplacement physique)
- ✅ **roosync_reply_message** : Répondre avec héritage thread/priority

## 📊 Statistiques

| Métrique | Valeur |
|----------|--------|
| **Outils MCP** | 14 (9 Heartbeat + 5 Messaging) |
| **Lignes de code** | ~3500 |
| **Tests unitaires** | 68 (19 Heartbeat + 49 Messaging) |
| **Coverage** | 100% |
| **Tests E2E** | 8/8 (100%) |
| **Documentation** | 2800+ lignes |

## 🏗️ Architecture

```
.shared-state/
├── messages/          # Système de messagerie
│   ├── inbox/        # Messages reçus non archivés
│   ├── sent/         # Copies messages envoyés
│   └── archive/      # Messages archivés
└── heartbeats/        # Système de heartbeat
    ├── heartbeats.json      # État des heartbeats
    └── heartbeat-service.json # Configuration du service
```

**Format Message JSON :**
```json
{
  "id": "msg-YYYYMMDDTHHMMSS-random",
  "from": "machine-id",
  "to": "machine-id",
  "subject": "Sujet",
  "body": "Contenu markdown",
  "status": "unread|read|archived",
  "priority": "low|medium|high|urgent",
  "tags": ["tag1", "tag2"],
  "thread_id": "msg-id-parent",
  "reply_to": "msg-id",
  "timestamp": "ISO 8601"
}
```

**Format Heartbeat JSON :**
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

## 📖 Documentation

### 💓 Heartbeat System
- **[HEARTBEAT-USAGE.md](HEARTBEAT-USAGE.md)** : Guide utilisateur complet
  - Description des 9 outils MCP
  - 4 scénarios d'usage
  - Bonnes pratiques et recommandations
- **[HEARTBEAT-EXAMPLES.md](HEARTBEAT-EXAMPLES.md)** : Exemples d'utilisation avancés
  - Exemples de base
  - Scénarios complets (surveillance, synchronisation)
  - Intégration avec autres services
  - Scripts d'automatisation
  - Cas d'usage avancés
- **[HEARTBEAT-TROUBLESHOOTING.md](HEARTBEAT-TROUBLESHOOTING.md)** : Guide de dépannage
  - Problèmes courants et solutions
  - Erreurs spécifiques
  - Outils de diagnostic
  - Récupération et restauration
  - FAQ

### 📨 Messaging System
- **[MESSAGING-USAGE.md](MESSAGING-USAGE.md)** : Guide utilisateur complet
  - Exemples pour chaque outil
  - 5 scénarios d'usage
  - Workflows complets

## 🧪 Tests

### Tests Unitaires
```powershell
cd mcps/internal/servers/roo-state-manager
npm test
```

**Résultats** :
- MessageManager : 31/31 tests ✅ (100% coverage)
- mark_message_read : 4/4 tests ✅
- archive_message : 5/5 tests ✅
- reply_message : 9/9 tests ✅

### Tests E2E
Voir : `roo-config/reports/roosync-messaging-e2e-test-report-20251016.md`

**Scénario testé** : Workflow bidirectionnel complet (8 étapes)
**Résultat** : 100% succès ✅

## 🚦 Workflow Exemple

```typescript
// 1. Envoi message
roosync_send_message({
  from: "machine1",
  to: "machine2",
  subject: "Hello",
  body: "Message content",
  priority: "high"
})

// 2. Lecture inbox destinataire
roosync_read_inbox({
  recipient_machine_id: "machine2",
  status: "unread"
})

// 3. Lecture message complet
roosync_get_message({
  message_id: "msg-xxx",
  mark_as_read: false
})

// 4. Marquer comme lu
roosync_mark_message_read({
  message_id: "msg-xxx"
})

// 5. Répondre
roosync_reply_message({
  message_id: "msg-xxx",
  body: "Ma réponse",
  priority: "urgent"
})

// 6. Archiver
roosync_archive_message({
  message_id: "msg-xxx"
})
```

## 🔒 Sécurité & Limitations

- **Mono-machine** : Chaque serveur MCP lit uniquement sa propre inbox locale
- **Shared State** : Nécessite répertoire Google Drive partagé
- **Concurrence** : IDs uniques garantis (timestamp + random)
- **Persistence** : Fichiers JSON avec atomic writes

## 🛠️ Configuration

**Prérequis** :
1. Répertoire partagé configuré dans `.env`
2. Structure répertoires créée (`messages/inbox`, `sent`, `archive`)
3. `sync-config.json` avec `machineId` défini

**Variables d'environnement** :
```env
SHARED_STATE_PATH=G:/Mon Drive/Synchronisation/RooSync/.shared-state
```

## 🚀 Prochaines Étapes

### Heartbeat System
- [ ] Intégration complète des callbacks de synchronisation
- [ ] Notifications push pour les changements de statut
- [ ] Tableau de bord de surveillance en temps réel
- [ ] Historique des heartbeats avec graphiques
- [ ] Alertes avancées avec règles personnalisées

### Messaging System
- [ ] Recherche messages (par sujet, expéditeur, tags)
- [ ] Gestion threads avancée
- [ ] Statistiques messagerie
- [ ] Notifications temps réel
- [ ] Attachments support

## 📝 Historique

- **v3.0.0** (15/01/2026) : Système Heartbeat complet (9 outils MCP)
- **v2.0** (16/10/2025) : Phase 2 messagerie (Management Tools)
- **v1.0** (16/10/2025) : Phase 1 messagerie (Core Tools)

## 🤝 Contributions

Ce système a été développé en collaboration entre :
- **myia-po-2024** : Implémentation, tests, documentation
- **myia-ai-01** : Architecture RooSync v3.0, spécifications heartbeat et messagerie

## 📄 License

Voir LICENSE du projet parent.