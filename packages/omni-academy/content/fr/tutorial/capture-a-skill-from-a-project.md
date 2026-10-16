---
title: Capturer un skill depuis un projet
kind: tutorial
summary: Copier un skill propre à un projet dans un plugin de votre marketplace personnelle.
minutes: 4
products: [claude-code, codex]
illustration: skill
topic: skills
cta: { route: projects, label: Ouvrir l’espace de travail }
steps: [1. Ouvrir les skills du projet, 2. Lire le skill, 3. Choisir un plugin et ajouter]
---

## 1. Ouvrir les skills du projet

Depuis `Espace de travail`, ouvrez le projet, puis `Gérer les skills`. Restez sur `Skills` et repérez un skill actif marqué `Seulement dans ce projet`.

Il faut une marketplace personnelle enregistrée et une copie installée lisible. Un skill externe utilise l’action distincte `Copier dans ma marketplace`.

Ce que vous verrez : les skills du projet, dont un skill présent seulement dans ce projet.

[screenshot:capture-skill-project]

## 2. Lire le skill

Choisissez le nom du skill pour ouvrir sa fiche. Lisez `Ce que fait ce skill`, `Vient de`, `Installé dans` et `Contenu`.

Pour un skill actif propre au projet, choisissez `Ajouter à ma marketplace`. Cette action ouvre la fiche de capture sans écrire le skill.

Ce que vous verrez : la fiche du skill avec son contenu et `Ajouter à ma marketplace`.

[screenshot:capture-skill-detail]

## 3. Choisir un plugin et ajouter

Sous `Ranger dans`, choisissez un plugin existant, ou `＋ Nouveau plugin` puis renseignez son nom et sa description en anglais. Un skill du même nom dans le plugin bloque la capture.

Lisez `Ce qui change` : la destination reçoit le nouveau skill ; la copie du projet est reliée à votre marketplace sans modification de ses fichiers. La ligne Git reflète le réglage de commit actuel.

Le bouton final `Ajouter` écrit la capture lorsque son plan est prêt. Après approbation, ouvrez `Historique` pour son reçu.

Ce que vous verrez : les choix de plugin de destination, `Ce qui change` et le bouton final `Ajouter`.

[screenshot:capture-skill-preview]

Et ensuite, lisez [marketplaces](academy://topic/marketplaces), puis [Ajouter un plugin à un projet](academy://tutorial/add-a-plugin-to-a-project).
