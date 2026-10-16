---
title: Installer une marketplace à la main
kind: tutorial
summary: Retrouver la marketplace locale et observer une installation native dans Omni.
minutes: 4
products: [claude-code, codex]
illustration: terminal
topic: claude-code
cta: { route: library, label: Ouvrir l’espace de travail }
steps: [1. Retrouver la marketplace, 2. Suivre les instructions natives de l’agent, 3. Observer le projet ensuite]
---

## 1. Retrouver la marketplace

Depuis `Espace de travail`, ouvrez `Ma marketplace ·` suivi du nom de votre marketplace. Son canvas regroupe les skills observés par plugin.

Pour retrouver le chemin local enregistré, ouvrez `Réglages` et lisez la section `Marketplace`. Connecter cette source à Omni n’installe pas de plugin natif dans un agent.

Ce que vous verrez : le canvas de la marketplace personnelle avec ses groupes de plugins.

[screenshot:install-marketplace-library]

## 2. Suivre les instructions natives de l’agent

Choisissez `Plugins et vitrines` pour examiner la liste des plugins. Le menu `Plus d'actions pour` d’un plugin concerne la publication et la création de skills ; il ne contient pas de guide d’installation manuelle ni de conversion de compatibilité.

L’installation native d’une marketplace entière se fait hors d’Omni, avec les instructions de l’agent choisi et les manifestes natifs du dépôt. Cette fiche ne fournit ni commandes d’installation ni verdict de compatibilité. Ne copiez pas de manifeste vers un chemin supposé.

Pour rester dans Omni, suivez [Ajouter un plugin à un projet](academy://tutorial/add-a-plugin-to-a-project) afin de sélectionner ses skills.

Ce que vous verrez : le menu d’actions d’un plugin dans la fiche de la marketplace.

[screenshot:install-marketplace-menu]

## 3. Observer le projet ensuite

Après une installation manuelle, revenez à `Espace de travail`, ouvrez le projet enregistré concerné et choisissez `Actualiser`, puis `Gérer les skills`.

Lisez ses onglets `Skills` et `Instructions`. Les pastilles d’agents montrent les copies observées ; elles ne prouvent pas que le chargeur natif a activé le plugin. Vérifiez ce chargement dans l’agent lui-même.

Ce que vous verrez : les skills observés du projet et leurs pastilles `Claude Code` et `Codex`.

[screenshot:install-marketplace-harnesses]

Et ensuite, lisez [marketplaces](academy://topic/marketplaces), puis [Ajouter un plugin à un projet](academy://tutorial/add-a-plugin-to-a-project).
