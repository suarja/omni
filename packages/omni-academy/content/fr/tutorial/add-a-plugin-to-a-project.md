---
title: Ajouter un plugin à un projet
kind: tutorial
summary: Choisir les skills d’un plugin dans un projet et les agents qui les recevront.
minutes: 4
products: [claude-code, codex]
illustration: plugin
topic: projects
cta: { route: projects, label: Ouvrir l’espace de travail }
steps: [1. Ouvrir le projet, 2. Choisir les skills, 3. Vérifier les agents et ajouter]
---

## 1. Ouvrir le projet

Depuis `Espace de travail`, ouvrez le nœud du projet cible, puis choisissez `Gérer les skills`. Lisez le nom et le dossier du projet dans la fiche.

Les onglets sont `Skills`, `Instructions` et `Infos`. Ce parcours ajoute des skills de votre marketplace personnelle ; il n’installe pas un plugin entier avec ses commandes ou hooks.

Ce que vous verrez : la fiche du projet sur `Skills`, avec `＋ Ajouter des skills` en bas.

[screenshot:add-plugin-project]

## 2. Choisir les skills

Choisissez `＋ Ajouter des skills`. La fiche `Ajouter des skills` liste les skills de la marketplace qui ne sont pas encore dans ce projet. Chaque ligne indique le package source.

Cochez les skills du plugin souhaité. Ce parcours ne propose pas de sélection du plugin entier. Les skills déjà assignés sont absents de la liste.

Ce que vous verrez : les skills disponibles, leurs identifiants de package et les choix `Agents`.

[screenshot:add-plugin-picker]

## 3. Vérifier les agents et ajouter

Vérifiez le nom du projet, les skills sélectionnés et les cases `Claude Code` et `Codex` sous `Agents`. Les deux agents sont sélectionnés au départ.

`Ajouter (2)`, par exemple, applique directement les deux skills sélectionnés après préparation des opérations. Il n’y a pas d’assignation enregistrée à approuver ensuite dans À valider. Choisissez ce bouton seulement si la sélection est correcte.

Examinez ensuite le résultat et ouvrez `Historique` pour les reçus. Un échec peut laisser un résultat partiel ; lisez-le avant de réessayer.

Ce que vous verrez : deux skills sélectionnés, les choix d’agents et `Ajouter (2)` avant le clic.

[screenshot:add-plugin-assignment]

Et ensuite, lisez [marketplaces](academy://topic/marketplaces), puis [Capturer un skill depuis un projet](academy://tutorial/capture-a-skill-from-a-project).
