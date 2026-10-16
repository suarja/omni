---
title: Omni pour vos agents
kind: course
summary: Donner à Claude Code et Codex une porte MCP locale et consentie vers votre espace de travail.
products: [claude-code, codex]
illustration: agent
topic: mcp
cta: { route: agents-setup, label: Ouvrir les réglages }
---

## Ouvrir la porte MCP locale

Omni expose un serveur MCP local pour les sessions de harness identifiées. Il répond à partir des projets, marketplaces et preuves d’activité enregistrés.

Ouvrez `Réglages` dans le rail du canvas et repérez `Agents`.

- La configuration reste locale.
- La page nomme les harnesses détectés.
- `Vérifier la connexion` sur la ligne de l’agent indique son dernier appel réel à Omni.

## Choisir un harness explicitement

Choisissez `Connecter` sur la ligne d’un agent détecté mais pas connecté. Chaque agent se connecte séparément.

La sélection contrôle le périmètre du plan généré ; ce n’est pas un interrupteur global.

- Vérifiez le nom de l’agent dans la confirmation.
- Traitez chaque harness comme une projection distincte.
- Lisez le résumé de connexion avant son bouton final `Connecter`.

## Consentir avant toute écriture

La confirmation décrit l’outil, les skills et la protection des fichiers. Elle ne liste pas de diffs fichier par fichier. Une demande d’agent peut recevoir son consentement dans la conversation ou dans Omni.

Le bouton final `Connecter` prépare et applique l’installation.

- Lisez le résumé avant `Connecter`.
- Refusez ou reportez un plan incompris.
- Le résultat appliqué devient un reçu.

## Lire et restaurer le reçu

Historique enregistre les opérations terminées et leurs résultats. Une restauration compare ensuite le contenu actuel au reçu d’origine.

La porte MCP reste ainsi vérifiable sans devenir une dépendance cloud.

- Ouvrez `À valider` pour les demandes en attente et `Historique` pour les opérations terminées.
- Utilisez un bouton `Annuler` éligible dans Historique et lisez sa prévisualisation inverse.
- Utilisez `Vérifier la connexion` dans le menu de l’agent pour lire la preuve du dernier appel.

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
