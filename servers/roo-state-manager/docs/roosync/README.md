# 📨 RooSync Messaging System

**Version** : 2.0 (Phase 1+2 complète)
**Status** : ✅ Production Ready
**Date** : 16 octobre 2025

## 🎯 Vue d'Ensemble

Le système de messagerie RooSync permet l'échange de messages structurés entre machines via un répertoire partagé (Google Drive), utilisant des fichiers JSON pour la persistence et des outils MCP pour l'interaction.

## 🚀 Fonctionnalités

### Phase 1 - Core Tools
- ✅ **roosync_send_message** : Envoi messages structurés avec métadonnées
- ✅ **roosync_read_inbox** : Lecture boîte de réception avec filtrage
- ✅ **roosync_get_message** : Lecture message complet avec formatage

### Phase 2 - Management Tools
- ✅ **roosync_mark_message_read** : Marquer messages comme lus
- ✅ **roosync_archive_message** : Archiver messages (déplacement physique)
- ✅ **roosync_reply_message** : Répondre avec héritage thread/priority

## 📊 Statistiques

| Métrique | Valeur |
|----------|--------|
| **Outils MCP** | 6 |
| **Lignes de code** | ~2300 |
| **Tests unitaires** | 49 (31 MessageManager + 18 outils) |
| **Coverage** | 70-100% |
| **Tests E2E** | 8/8 (100%) |
| **Documentation** | 1200+ lignes |

## 🏗️ Architecture

```
messages/
├── inbox/        # Messages reçus non archivés
├── sent/         # Copies messages envoyés
└── archive/      # Messages archivés

Format JSON :
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

## 📖 Documentation

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
Voir : [`roo-config/reports/roosync-messaging-e2e-test-report-20251016.md`](../../../../../roo-config/reports/roosync-messaging-e2e-test-report-20251016.md)

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

## 🚀 Prochaines Étapes (Phase 3)

- [ ] Recherche messages (par sujet, expéditeur, tags)
- [ ] Gestion threads avancée
- [ ] Statistiques messagerie
- [ ] Notifications temps réel
- [ ] Attachments support

## 📝 Historique

- **v2.0** (16/10/2025) : Phase 2 complète (Management Tools)
- **v1.0** (16/10/2025) : Phase 1 complète (Core Tools)

## 🤝 Contributions

Ce système a été développé en collaboration entre :
- **myia-po-2024** : Implémentation, tests, documentation
- **myia-ai-01** : Architecture RooSync v2.0, spécifications messagerie

## 📄 License

Voir LICENSE du projet parent.