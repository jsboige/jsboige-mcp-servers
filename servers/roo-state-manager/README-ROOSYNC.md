# RooSync - Synchronisation Multi-Machines

Système de synchronisation de configurations Roo entre machines Windows via MCP.

## Workflow Principal (4 étapes)

1. **Observer** : `roosync_get_status` - Voir l'état de synchronisation
2. **Comparer** : `roosync_compare_config` - Détecter les différences avec la baseline
3. **Valider** : Consulter `sync-roadmap.md` et approuver les décisions
4. **Appliquer** : `roosync_apply_decision` - Appliquer les changements validés

## Commandes Principales

| Commande | Description |
|----------|-------------|
| `roosync_get_status` | État de synchronisation actuel |
| `roosync_compare_config` | Comparer configurations entre machines |
| `roosync_list_diffs` | Lister les différences détectées |
| `roosync_approve_decision` | Approuver une décision de synchronisation |
| `roosync_apply_decision` | Appliquer une décision approuvée |
| `roosync_send_message` | Envoyer un message inter-machines |
| `roosync_read_inbox` | Lire les messages reçus |

## Documentation Détaillée

- **Guide Rapide** : [`docs/roosync/QUICKSTART.md`](../../docs/roosync/QUICKSTART.md)
- **Guide Utilisation** : [`docs/roosync/GUIDE_UTILISATION_ROOSYNC.md`](../../docs/roosync/GUIDE_UTILISATION_ROOSYNC.md)
- **Documentation Complète** : [`docs/roosync/README.md`](../../docs/roosync/README.md)

## Fichiers Importants

- `sync-config.ref.json` - Baseline de référence
- `sync-roadmap.md` - Roadmap de validation
- `.shared-state/` - État partagé et messages

## En Cas de Problème

1. Vérifier que le MCP roo-state-manager est chargé
2. Lancer `roosync_get_status` pour voir l'état
3. Consulter les logs dans `.shared-state/logs/`
