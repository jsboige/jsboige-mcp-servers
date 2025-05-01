# Guide de contribution

Merci de votre intérêt pour contribuer aux serveurs MCP! Ce document fournit des directives pour contribuer à ce projet.

## Comment contribuer

### Signaler des bugs

Si vous trouvez un bug:

1. Vérifiez d'abord que le bug n'a pas déjà été signalé dans les [issues](https://github.com/jsboige/jsboige-mcp-servers/issues).
2. Créez une nouvelle issue en utilisant le template de bug.
3. Incluez autant de détails que possible: étapes pour reproduire, comportement attendu vs. observé, logs, captures d'écran, etc.

### Proposer des améliorations

Pour proposer une amélioration:

1. Créez une issue en utilisant le template de fonctionnalité.
2. Décrivez clairement la fonctionnalité et pourquoi elle serait utile.
3. Indiquez si vous êtes prêt à implémenter cette fonctionnalité vous-même.

### Soumettre des modifications

1. Forkez le dépôt.
2. Créez une branche pour votre fonctionnalité (`git checkout -b feature/amazing-feature`).
3. Committez vos changements (`git commit -m 'Add some amazing feature'`).
4. Poussez vers la branche (`git push origin feature/amazing-feature`).
5. Ouvrez une Pull Request.

## Standards de code

- Suivez les conventions de style existantes.
- Écrivez des tests pour les nouvelles fonctionnalités.
- Assurez-vous que tous les tests passent avant de soumettre une PR.
- Documentez le nouveau code et les nouvelles fonctionnalités.

## Structure pour les nouveaux serveurs MCP

Si vous ajoutez un nouveau serveur MCP, veuillez suivre cette structure:

```
servers/[catégorie]/[nom-du-serveur]/
├── README.md           # Documentation du serveur
├── package.json        # Dépendances et scripts
├── server.js           # Point d'entrée du serveur
└── config.example.json # Configuration d'exemple
```

## Processus de revue

- Chaque PR sera examinée par au moins un mainteneur.
- Les commentaires de revue doivent être adressés avant la fusion.
- Les PR doivent passer tous les tests automatisés.

Merci de contribuer à améliorer les serveurs MCP!