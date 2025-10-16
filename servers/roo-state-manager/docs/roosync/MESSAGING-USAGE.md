# 📨 RooSync Messaging System - Guide Utilisateur

**Version :** Phase 2 - Management Tools
**Date :** 16 octobre 2025
**Serveur MCP :** roo-state-manager

---

## 🎯 Vue d'Ensemble

Le système de messagerie RooSync permet une communication structurée et asynchrone entre machines via des outils MCP. Les messages sont stockés au format JSON dans des répertoires dédiés pour une organisation claire.

---

## 📁 Architecture de Stockage

```
.shared-state/messages/
├── inbox/          # Messages reçus par toutes les machines
├── sent/           # Messages envoyés par toutes les machines
└── archive/        # Messages archivés
```

**Format des messages :** JSON avec structure complète  
**Nommage :** `msg-{timestamp}-{random}.json`

---

## 🛠️ Outils Disponibles (Phase 1)

### 1. roosync_send_message

Envoyer un message structuré à une autre machine.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `to` | string | ✅ | ID machine destinataire (ex: myia-ai-01) |
| `subject` | string | ✅ | Sujet du message |
| `body` | string | ✅ | Corps du message (markdown supporté) |
| `priority` | string | ❌ | LOW\|MEDIUM\|HIGH\|URGENT (défaut: MEDIUM) |
| `tags` | array | ❌ | Liste de tags pour catégoriser |
| `thread_id` | string | ❌ | ID de thread pour regroupement |
| `reply_to` | string | ❌ | ID du message original |

**Exemple d'utilisation :**

```
Outil MCP : roosync_send_message
Serveur : roo-state-manager
Paramètres : {
  "to": "myia-ai-01",
  "subject": "Test Messagerie MCP - Phase 1",
  "body": "Ceci est un message de test.\n\n✅ 3 outils core implémentés.",
  "priority": "HIGH",
  "tags": ["test", "messaging", "phase1"]
}
```

**Résultat :**
- Message créé dans `messages/inbox/{message_id}.json` (destinataire)
- Message créé dans `messages/sent/{message_id}.json` (expéditeur)
- Retour avec ID unique et timestamp

---

### 2. roosync_read_inbox

Lire la boîte de réception de messages.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `status` | string | ❌ | unread\|read\|all (défaut: all) |
| `limit` | number | ❌ | Nombre max de messages |

**Exemple d'utilisation :**

```
Outil MCP : roosync_read_inbox
Serveur : roo-state-manager
Paramètres : {
  "status": "unread",
  "limit": 5
}
```

**Résultat :**
- Tableau formaté avec liste des messages
- Statistiques (total, non-lus, lus)
- Aperçu du message le plus récent
- Tri par date décroissant (plus récents en premier)

---

### 3. roosync_get_message

Obtenir un message complet par son ID.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `message_id` | string | ✅ | ID du message à récupérer |
| `mark_as_read` | boolean | ❌ | Marquer automatiquement comme lu (défaut: false) |

**Exemple d'utilisation :**

```
Outil MCP : roosync_get_message
Serveur : roo-state-manager
Paramètres : {
  "message_id": "msg-20251016125500-abc123",
  "mark_as_read": true
}
```

**Résultat :**
- Message complet avec toutes les métadonnées
- Corps du message formaté en markdown
- Liste des actions disponibles
- Status mis à jour si `mark_as_read: true`

---

## 🛠️ Outils Phase 2 - Management Tools

### 4. roosync_mark_message_read

Marquer un message comme lu en mettant à jour son statut.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `message_id` | string | ✅ | ID du message à marquer comme lu |

**Exemple d'utilisation :**

```
Outil MCP : roosync_mark_message_read
Serveur : roo-state-manager
Paramètres : {
  "message_id": "msg-20251016125500-abc123"
}
```

**Résultat :**
- Status mis à jour de `unread` → `read`
- Fichier JSON modifié dans inbox/
- Confirmation avec détails du message

---

### 5. roosync_archive_message

Archiver un message en le déplaçant vers le dossier `archive/`.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `message_id` | string | ✅ | ID du message à archiver |

**Exemple d'utilisation :**

```
Outil MCP : roosync_archive_message
Serveur : roo-state-manager
Paramètres : {
  "message_id": "msg-20251016125500-abc123"
}
```

**Résultat :**
- Message déplacé de `inbox/` vers `archive/`
- Status mis à jour vers `archived`
- N'apparaît plus dans `roosync_read_inbox`
- Timestamp d'archivage ajouté

---

### 6. roosync_reply_message

Répondre à un message existant en créant un nouveau message lié.

**Serveur :** `roo-state-manager`

**Paramètres :**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `message_id` | string | ✅ | ID du message auquel répondre |
| `body` | string | ✅ | Corps de la réponse |
| `priority` | string | ❌ | LOW\|MEDIUM\|HIGH\|URGENT (défaut: priorité de l'original) |
| `tags` | array | ❌ | Tags supplémentaires (le tag "reply" est ajouté automatiquement) |

**Exemple d'utilisation :**

```
Outil MCP : roosync_reply_message
Serveur : roo-state-manager
Paramètres : {
  "message_id": "msg-20251016125500-abc123",
  "body": "Message bien reçu ! Tests validés de mon côté.",
  "priority": "HIGH",
  "tags": ["confirmation", "tests"]
}
```

**Résultat :**
- Nouveau message créé avec :
  - `from` et `to` inversés automatiquement
  - Sujet préfixé par "Re: "
  - `reply_to` pointant vers le message original
  - `thread_id` hérité ou créé avec l'ID original
  - Tag "reply" ajouté automatiquement
- Message envoyé au destinataire
- Affichage du message original et de la réponse

---

## 🔄 Workflow Typique

### Scénario 1 : Envoyer un message

1. **Identifier le destinataire** (ex: myia-ai-01)
2. **Utiliser `roosync_send_message`** avec les paramètres
3. **Vérifier le résultat** (ID message retourné)

### Scénario 2 : Consulter sa boîte de réception

1. **Utiliser `roosync_read_inbox`** pour voir les messages
2. **Noter l'ID du message** à lire
3. **Utiliser `roosync_get_message`** pour le contenu complet
4. **Optionnel :** Marquer comme lu avec `mark_as_read: true`

### Scénario 3 : Répondre à un message (Méthode manuelle - Phase 1)

1. **Lire le message original** avec `roosync_get_message`
2. **Noter l'ID du message** (pour `reply_to`)
3. **Utiliser `roosync_send_message`** avec :
   - `to`: expéditeur original
   - `reply_to`: ID du message original
   - `thread_id`: même thread_id si présent

### Scénario 4 : Répondre à un message (Phase 2 - Simplifié)

1. **Lire le message** avec `roosync_get_message`
2. **Utiliser `roosync_reply_message`** directement :
   - Inversion `from`/`to` automatique
   - Préfixe "Re: " automatique
   - Liaison thread automatique

### Scénario 5 : Workflow Complet Phase 2

```
# 1. Consulter boîte de réception
roosync_read_inbox({ status: "unread" })

# 2. Lire un message sans le marquer comme lu
roosync_get_message({
  message_id: "msg-20251016125500-abc123",
  mark_as_read: false
})

# 3. Marquer comme lu après analyse
roosync_mark_message_read({
  message_id: "msg-20251016125500-abc123"
})

# 4. Répondre au message
roosync_reply_message({
  message_id: "msg-20251016125500-abc123",
  body: "Bien reçu, tests validés !",
  priority: "HIGH",
  tags: ["confirmation"]
})

# 5. Archiver le message original
roosync_archive_message({
  message_id: "msg-20251016125500-abc123"
})
```

---

## 📊 Structure d'un Message

```json
{
  "id": "msg-20251016125500-abc123",
  "from": "myia-po-2024",
  "to": "myia-ai-01",
  "subject": "Test de messagerie",
  "body": "Contenu du message en markdown...",
  "priority": "HIGH",
  "timestamp": "2025-10-16T12:55:00.000Z",
  "status": "unread",
  "tags": ["test", "phase1"],
  "thread_id": "thread-abc123",
  "reply_to": "msg-20251016120000-xyz789"
}
```

---

## 🎨 Icônes et Indicateurs

### Priorité
- 🔥 URGENT
- ⚠️ HIGH
- 📝 MEDIUM
- 📋 LOW

### Status
- 🆕 unread (non-lu)
- ✅ read (lu)
- 📦 archived (archivé)

---

## 🚀 Prochaines Phases

**✅ Phase 2 - Management Tools (IMPLÉMENTÉ) :**
- ✅ `roosync_mark_message_read` : Marquer comme lu
- ✅ `roosync_archive_message` : Archiver un message
- ✅ `roosync_reply_message` : Répondre directement

**Phase 3 - Advanced Features :**
- Recherche de messages
- Gestion des threads de conversation
- Notifications et alertes
- Statistiques de messagerie

---

## 🔍 Dépannage

### Message non envoyé
- Vérifier que le répertoire `.shared-state/messages/` existe
- Vérifier les permissions d'écriture
- Vérifier que `sync-config.json` contient un `machineId` valide

### Inbox vide alors que des messages existent
- Vérifier que l'ID machine dans `sync-config.json` correspond au destinataire
- Vérifier que les fichiers sont bien dans `messages/inbox/`
- Les messages sont filtrés par destinataire automatiquement

### Message introuvable
- Vérifier l'ID exact du message (copier-coller)
- Le message peut être dans `sent/` ou `archive/` si déplacé
- Utiliser `roosync_read_inbox` pour lister les IDs disponibles

---

## 📝 Bonnes Pratiques

1. **Sujets clairs** : Utiliser des sujets descriptifs et concis
2. **Priorités** : Réserver URGENT pour les vrais urgences
3. **Tags** : Utiliser des tags cohérents pour faciliter la recherche future
4. **Threads** : Grouper les messages liés avec le même `thread_id`
5. **Réponses** : Toujours utiliser `reply_to` pour maintenir le contexte

---

*Documentation générée le 2025-10-16 - Phase 2 Implementation*