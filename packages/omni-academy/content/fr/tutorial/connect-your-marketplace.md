---
title: Connecter votre marketplace
kind: tutorial
summary: Enregistrer une marketplace locale existante depuis le panneau Ajouter de l’espace de travail.
minutes: 4
products: [claude-code, codex]
illustration: marketplace
topic: marketplaces
cta: { route: library-add, label: Ouvrir Ajouter Marketplace }
steps: [1. Ouvrir Ajouter Marketplace, 2. Choisir le type de source, 3. Lire la marketplace enregistrée]
---

## 1. Ouvrir Ajouter Marketplace

Au premier lancement, `Bienvenue dans Omni` affiche une carte avec trois emplacements : votre marketplace, vos projets et vos agents. Sous `Votre marketplace`, choisissez `Connecter l’existante` pour ouvrir directement le parcours personnel. `Créer ma marketplace` ouvre le formulaire de création avec un aperçu des fichiers et des effets Git.

Vous pouvez remplir les emplacements dans l’ordre de votre choix. Chaque emplacement terminé devient un vrai nœud. Après la première étape, la ligne de configuration propose `Masquer` ; utilisez `Aide`, puis `Afficher la configuration` pour retrouver les emplacements restants.

Vous pouvez aussi choisir `＋ Ajouter`, puis `Marketplace`. Sans marketplace personnelle connectée, la fiche s’ouvre sur `Ma première marketplace`. Si une marketplace existe déjà, elle s’ouvre sur `Source externe` pour les dépôts publiés par d’autres.

Connecter un dossier local l’enregistre dans Omni. Cela n’installe pas ses skills dans un projet.

Ce que vous verrez : le menu Ajouter avec `Projet`, `Marketplace` et `Nouveau skill`.

[screenshot:connect-marketplace-library]

## 2. Choisir le type de source

Pour le dépôt local de quelqu’un d’autre, choisissez `Source externe`, puis `Choisir un dossier…`. Pour votre première marketplace personnelle, gardez `Ma première marketplace`, puis choisissez `Choisir un dossier…` sous `Dépôt Git`.

Sélectionnez le dépôt existant dans le sélecteur système. Sa validation démarre directement l’enregistrement ; il n’y a pas de page de confirmation supplémentaire.

Si une marketplace personnelle existe déjà, l’onglet personnel s’appelle `Vitrine publique`. Il ouvre un parcours de vitrine, sans remplacer votre marketplace actuelle.

Ce que vous verrez : la fiche `Marketplace` avec les choix de source, `Dépôt GitHub` et `Choisir un dossier…`.

[screenshot:connect-marketplace-choose]

## 3. Lire la marketplace enregistrée

Attendez le résultat de l’enregistrement. Si la lecture échoue, utilisez `Réessayer la lecture` ; si elle se termine, choisissez `Terminer` pour revenir à `Espace de travail`.

Ouvrez le nœud de la marketplace pour examiner ses ressources observées. Votre marketplace personnelle s’ouvre sur un canvas regroupé par plugin. `Actualiser` relit les changements faits hors d’Omni.

Ce que vous verrez : le canvas de la marketplace personnelle enregistrée, avec ses groupes de plugins et ses nœuds de skills.

[screenshot:connect-marketplace-confirm]

Et ensuite, lisez [marketplaces](academy://topic/marketplaces), puis [Ajouter un plugin à un projet](academy://tutorial/add-a-plugin-to-a-project).
