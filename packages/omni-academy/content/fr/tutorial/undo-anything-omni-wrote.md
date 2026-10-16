---
title: Annuler une écriture d’Omni
kind: tutorial
summary: Lire une opération dans Historique et vérifier sa restauration avant approbation.
minutes: 4
products: [claude-code, codex]
illustration: lesson
topic: agents-at-work
cta: { route: library, label: Ouvrir l’espace de travail }
steps: [1. Ouvrir l’historique, 2. Lire le résultat de l’opération, 3. Vérifier l’opération inverse]
---

## 1. Ouvrir l’historique

Choisissez `Historique` dans le rail du canvas. Il liste ce qu’Omni a écrit, qui l’a demandé et quand.

Repérez l’opération sur la cible souhaitée. `Annuler` apparaît seulement pour les reçus éligibles. Certaines opérations ne sont pas réversibles ici ; le titre de ce tutoriel ne promet pas le contraire.

Ce que vous verrez : l’historique avec les opérations terminées et les boutons `Annuler` éligibles.

[screenshot:undo-review]

## 2. Lire le résultat de l’opération

Ouvrez la ligne de l’opération pour examiner son résultat. Vérifiez la cible, les fichiers modifiés et le résultat Git lorsqu’il est enregistré. Les opérations de skills peuvent ouvrir une fiche différente de celle d’une capture.

Pour un skill capturé depuis un projet, le reçu propose `Restaurer`. Lisez le reçu avant de choisir cette action.

Ce que vous verrez : un reçu de capture de skill avec le résultat d’origine et `Restaurer`.

[screenshot:undo-receipt]

## 3. Vérifier l’opération inverse

Choisissez `Restaurer` dans ce reçu. Cette action ouvre une prévisualisation ; le bouton final `Restaurer` l’applique. Lisez la prévisualisation et tout blocage avant de confirmer.

Omni compare le contenu actuel au reçu d’origine et protège les modifications ultérieures. Si la restauration est bloquée, conservez ces modifications et résolvez la cause avant de réessayer.

Vous pouvez aussi ouvrir directement le parcours inverse d’une opération éligible avec `Annuler` dans Historique. Après approbation, lisez son résultat, y compris tout échec partiel.

Ce que vous verrez : la fiche de restauration avant le bouton final `Restaurer`, avec les effets inverses proposés.

[screenshot:undo-restore]

Et ensuite, lisez [marketplaces](academy://topic/marketplaces), puis [Capturer un skill depuis un projet](academy://tutorial/capture-a-skill-from-a-project).
