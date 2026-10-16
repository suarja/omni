---
title: Installer Omni pour vos agents
kind: tutorial
summary: Connecter chaque agent détecté depuis Réglages et vérifier un appel réel à Omni.
minutes: 4
products: [claude-code, codex]
illustration: agent
topic: mcp
cta: { route: agents-setup, label: Ouvrir les réglages }
steps: [1. Ouvrir les réglages, 2. Choisir un agent, 3. Confirmer et vérifier une session]
---

## 1. Ouvrir les réglages

Choisissez `Réglages` dans le rail du canvas. La section `Agents` montre chaque agent pris en charge et son état de connexion observé.

`Introuvable sur ce Mac` signifie qu’aucune action de connexion n’est proposée. Configurez l’agent localement, puis rouvrez les réglages.

Ce que vous verrez : les réglages avec la section `Agents` et l’état de chaque agent.

[screenshot:install-agents-home]

## 2. Choisir un agent

Pour un agent détecté marqué `Pas connecté`, choisissez `Connecter` sur sa ligne. Chaque agent se connecte séparément.

Lisez `Connecter Codex ?` ou `Connecter Claude Code ?`. La confirmation décrit l’outil omni, les skills d’Omni et la protection des fichiers qu’il gère.

Ce que vous verrez : la confirmation de connexion d’un agent détecté mais pas encore connecté.

[screenshot:install-agents-select]

## 3. Confirmer et vérifier une session

Lisez la confirmation avant son bouton final `Connecter`. Ce clic prépare et applique l’installation. La fiche présente un résumé plutôt que des diffs fichier par fichier.

Après connexion, ouvrez une nouvelle session de l’agent et faites un appel à Omni. Revenez au menu `Plus d'actions` de sa ligne, puis à `Vérifier la connexion`, pour lire la preuve du dernier appel. Le statut connecté seul ne prouve pas qu’un appel a réussi.

Répétez pour un autre agent si nécessaire. N’utilisez pas `Réinstaller` pour examiner une connexion : cette action écrit des fichiers.

Ce que vous verrez : le résumé de connexion et le bouton final `Connecter` avant l’installation.

[screenshot:install-agents-review]

Et ensuite, lisez [marketplaces](academy://topic/marketplaces), puis [Annuler une écriture d’Omni](academy://tutorial/undo-anything-omni-wrote).
