---
title: Garder les projets synchronisés
kind: course
summary: Assigner le bon contexte, repérer les dérives, capturer les améliorations et laisser Git garder l’historique.
products: [claude-code, codex]
illustration: project
topic: projects
cta: { route: projects, label: Ouvrir l’espace de travail }
---

## Commencer par un projet observé

Un projet est une racine locale enregistrée, pas seulement un nom dans une liste. Son observation donne à Omni les preuves nécessaires à une assignation sûre.

Ouvrez le nœud du projet dans `Espace de travail`, puis choisissez `Gérer les skills` avant toute écriture.

- Lisez le chemin du projet et les harnesses.
- Utilisez `Skills` pour les skills observés et leurs origines.
- Utilisez `Infos` pour les preuves du projet et `À valider` dans le rail pour les vérifications.

## Assigner depuis la marketplace

Choisissez `＋ Ajouter des skills` dans la fiche du projet. Le sélecteur garde le projet cible visible pendant le choix des skills de votre marketplace.

Ce sélecteur choisit des skills individuels. Il n’installe pas de plugin entier avec ses commandes ou hooks.

- Cochez les skills disponibles du plugin lorsque leur usage va ensemble.
- Choisissez un skill seul quand le périmètre doit rester précis.
- Gardez les lignes de harness `Claude Code` et `Codex` explicites.

## Repérer tôt les dérives

Le projet et sa source de marketplace peuvent évoluer séparément. Choisissez `Actualiser` quand des fichiers ou manifestes locaux ont changé.

La liste des skills distingue les origines et les états de mise à jour des opérations qui pourraient les résoudre.

- Lisez le type et la sévérité du constat.
- Ouvrez la racine concernée plutôt que d’interpréter un compteur.
- Gardez les modifications récentes hors de la restauration.

## Capturer et laisser Git raconter

Dans `Skills`, ouvrez un skill actif propre au projet puis `Ajouter à ma marketplace`. Choisissez sa destination sous `Ranger dans` et lisez `Ce qui change`.

Le reçu décrit ce qu’Omni a écrit. Git décrit l’entrée dans l’historique ; aucun ne remplace l’autre.

- Inspectez le résumé de capture avant le bouton final `Ajouter`.
- Le bouton `Ajouter (nombre)` applique directement les skills choisis ; aucune approbation ultérieure n’est prévue dans À valider.
- Utilisez `Annuler` dans `Historique` quand le reçu et le contrôle de dérive le permettent.

## Avant d’agir

Commencez par la page observée, pas par une hypothèse sur le système de fichiers. La route et son en-tête disent quelle cible est dans le périmètre d’Omni.

- Lisez le titre et l’onglet actif.
- Préférez l’action nommée au raccourci.
- Gardez le chemin local pour la comparaison.

## Vérifier la frontière

Toute prévisualisation reste en lecture seule jusqu’à l’action d’approbation. Un blocage ou une indisponibilité est une preuve qui demande une autre décision.

- Traitez une racine introuvable comme indisponible.
- Traitez un conflit comme un arrêt.
- Gardez le nom du harness près du chemin.

## Garder la trace

Après une écriture, Historique conserve la trace des opérations. Le reçu et le commit Git se complètent pour rendre une restauration délibérée.

- Lisez les fichiers du reçu.
- Comparez les modifications récentes avant de restaurer.
- Revenez à la source de vérité pour le changement suivant.

## Une vérification régulière

Rouvrez la source et le projet quand les conventions de votre harness changent. Cette courte revue relie l’opération suivante aux preuves locales actuelles.

- Actualisez la racine observée.
- Lisez les chemins modifiés.
- Choisissez une seule action délibérée.
