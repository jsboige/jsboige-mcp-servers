# Documentation roo-state-manager

Cette documentation est organisée par thématique pour faciliter la navigation.

## 📁 Structure

```
docs/
├── debug/              # Guides de débogage et résolution de problèmes
├── implementation/     # Rapports de phases d'implémentation
├── parsing/            # Documentation sur le parsing XML et la hiérarchie
├── reports/            # Rapports de mission et validations
├── tests/              # Documentation sur l'organisation des tests
└── README.md           # Ce fichier
```

## 🐛 Debug

Documentation pour diagnostiquer et résoudre les problèmes :

- [`DEBUG-RESOLUTION-CYCLES.md`](debug/DEBUG-RESOLUTION-CYCLES.md) - Résolution des cycles dans la reconstruction hiérarchique
- [`DEBUGGING.md`](debug/DEBUGGING.md) - Guide général de débogage

## 🚀 Implementation

Rapports de phases d'implémentation :

- [`PHASE1-IMPLEMENTATION-REPORT.md`](implementation/PHASE1-IMPLEMENTATION-REPORT.md) - Rapport Phase 1
- [`PHASE2-VALIDATION-REPORT.md`](implementation/PHASE2-VALIDATION-REPORT.md) - Rapport Phase 2

## 🌲 Parsing & Hiérarchie

Documentation sur le parsing XML et la reconstruction de l'arbre des tâches :

- [`ARBRE_CONVERSATION_CLUSTER.md`](parsing/ARBRE_CONVERSATION_CLUSTER.md) - Visualisation des grappes de conversations
- [`ARBRE_HIERARCHIE_RECONSTRUITE_REPARE.md`](parsing/ARBRE_HIERARCHIE_RECONSTRUITE_REPARE.md)
- [`ARBRE_TACHES_MEGA_CONVERSATION_9381_MESSAGES.md`](parsing/ARBRE_TACHES_MEGA_CONVERSATION_9381_MESSAGES.md)
- [`ARBRE_TACHES_TEST_PARSING_FIX.md`](parsing/ARBRE_TACHES_TEST_PARSING_FIX.md)
- [`ARBRE_TACHES_VALIDATION_FINALE_6308_MESSAGES.md`](parsing/ARBRE_TACHES_VALIDATION_FINALE_6308_MESSAGES.md)
- [`HARMONISATION_PARENTIDS_COMPLETE.md`](parsing/HARMONISATION_PARENTIDS_COMPLETE.md) - Harmonisation des ParentIds
- [`RAPPORT_PARSING_XML_SOUS_TACHES.md`](parsing/RAPPORT_PARSING_XML_SOUS_TACHES.md)
- [`VALIDATION_FINALE_PARSING_XML_REPARE.md`](parsing/VALIDATION_FINALE_PARSING_XML_REPARE.md)

## 📊 Reports

Rapports de mission, validations et déploiements :

- [`CONSOLIDATION-DOCUMENTATION.md`](reports/CONSOLIDATION-DOCUMENTATION.md) - Rapport consolidation docs (2025-10-02)
- [`FINALISATION_MISSION_PARSING.md`](reports/FINALISATION_MISSION_PARSING.md)
- [`INDEX-LIVRABLES-REORGANISATION-TESTS.md`](reports/INDEX-LIVRABLES-REORGANISATION-TESTS.md)
- [`RAPPORT-AVANCEMENT-REORGANISATION.md`](reports/RAPPORT-AVANCEMENT-REORGANISATION.md)
- [`RAPPORT-DEPLOIEMENT-PHASE2.md`](reports/RAPPORT-DEPLOIEMENT-PHASE2.md)
- [`RAPPORT-FINAL-MISSION-VALIDATION-REORGANISATION-TESTS.md`](reports/RAPPORT-FINAL-MISSION-VALIDATION-REORGANISATION-TESTS.md)
- [`RAPPORT-FINAL-VALIDATION-ARCHITECTURE-CONSOLIDEE.md`](reports/RAPPORT-FINAL-VALIDATION-ARCHITECTURE-CONSOLIDEE.md)
- [`RAPPORT-MISSION-ORCHESTRATEUR-VALIDATION-COMPLETE.md`](reports/RAPPORT-MISSION-ORCHESTRATEUR-VALIDATION-COMPLETE.md)

## 🧪 Tests

Documentation sur l'organisation et la structure des tests :

- [`2025-09-28_validation_tests_unitaires_reconstruction_hierarchique.md`](tests/2025-09-28_validation_tests_unitaires_reconstruction_hierarchique.md) - Validation tests unitaires
- [`AUDIT-TESTS-LAYOUT.md`](tests/AUDIT-TESTS-LAYOUT.md) - Audit de l'organisation des tests
- [`MIGRATION-PLAN-TESTS.md`](tests/MIGRATION-PLAN-TESTS.md) - Plan de migration des tests
- [`NOUVEAU-LAYOUT-TESTS.md`](tests/NOUVEAU-LAYOUT-TESTS.md) - Nouveau layout cible
- [`RAPPORT-FINAL-CORRECTION-TESTS-POST-MERGE.md`](tests/RAPPORT-FINAL-CORRECTION-TESTS-POST-MERGE.md) - Corrections post-merge
- [`TEST-SUITE-COMPLETE-RESULTS.md`](tests/TEST-SUITE-COMPLETE-RESULTS.md) - Résultats complets
- [`TESTS-ORGANIZATION.md`](tests/TESTS-ORGANIZATION.md) - Organisation générale

## 📝 Conventions

- Les noms de fichiers en MAJUSCULES sont des rapports ou documents officiels
- Les fichiers avec timestamp (YYYY-MM-DD) sont des snapshots ponctuels
- Les fichiers préfixés "ARBRE_" contiennent des visualisations d'arbres de tâches
- Les fichiers préfixés "RAPPORT_" sont des rapports de mission

## 🔄 Maintenance

Cette structure a été créée le 2025-10-02 lors de la consolidation de la documentation dispersée.
Pour toute modification de la structure, référez-vous au script [`scripts/consolidate-docs.ps1`](../scripts/consolidate-docs.ps1).