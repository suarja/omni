export const workspace = {
  brandName: "Omni",
  back: "Retour",
  name: "Espace personnel",
  personalMarketplaceLabel: "MA MARKETPLACE",
  localFirst: "Priorité au local",
  searchPlaceholder: "Rechercher",
  searchAriaLabel: "Rechercher dans l’espace de travail",
  mainNavigationAriaLabel: "Navigation principale",
  settings: "Réglages",
  refreshSource: "Actualiser la source",
  waitingForLocalSource: "En attente d’une source locale",
  noSourceLoaded: "Aucune source chargée",
  noHarnessLoaded: "Aucun harnais chargé",
  noProjectLoaded: "Aucun projet sélectionné",
  projectInventory: "Inventaire du projet",
  waitingForProject: "En attente d’un projet",
  sourceAvailable: "Marketplace personnelle",
  sourceMissing: "Marketplace personnelle · introuvable",
  sourceInaccessible: "Marketplace personnelle · inaccessible",
  noPersonalMarketplace: "Aucune marketplace personnelle",
  connectPersonalMarketplace: "Connectez-en une dans la bibliothèque",
};

export const navigation = {
  home: "Accueil",
  library: "Bibliothèque",
  projects: "Projets",
  review: "Revue",
  activity: "Activité",
  learn: "Apprendre",
  settings: "Réglages",
};

export const bootstrap = {
  loading: "Chargement du registre local…",
  loadingDescription: "Omni lit les projets et les sources enregistrés.",
  loadFailedHeading: "Omni n’a pas pu démarrer",
  retry: "Réessayer",
};

export const home = {
  eyebrow: "Vue de l’espace",
  heading: "Bonjour",
  description: "Gérez vos outils IA une fois. Utilisez-les de la même façon dans tous vos projets.",
  summaryAriaLabel: "Résumé du registre de l’espace",
  projects: "Projets",
  sources: "Sources",
  findings: "Constats",
  nextActionEyebrow: "Prochaine action",
  nextActionHeading: "Prochaine décision",
  nextActionDescription:
    "Ouvrez Projets pour inspecter les codebases enregistrées ou Bibliothèque pour inspecter les sources enregistrées.",
  openProjects: "Ouvrir les projets",
  openLibrary: "Ouvrir la bibliothèque",
  nextActions: {
    connect: "Connecter une source personnelle",
    connectDescription:
      "Aucune source personnelle active n’est enregistrée. Connectez la marketplace locale que vous utilisez déjà.",
    audit: "Lancer l’audit",
    auditDescription:
      "Aucun rapport d’audit actuel n’est disponible. Inspectez les racines enregistrées pour établir les preuves locales actuelles.",
    review: "Ouvrir la revue",
    reviewDescription: "Le dernier audit contient des constats qui nécessitent votre attention.",
    findingsDescription: "{variants} variante(s) et {duplicates} groupe(s) de doublons à examiner.",
    duplicateTitle: "{name} est dupliqué",
    projects: "Inspecter les projets",
    projectsDescription: "Le dernier audit est actuel. Ouvrez Projets pour inspecter une codebase enregistrée.",
    resolveConflict: "Résoudre un conflit dans {project}",
    conflictDescription: "Une modification locale bloque une mise à jour sûre de l’assignation.",
    assignment: {
      one: "{count} changement en attente d’approbation",
      other: "{count} changements en attente d’approbation",
    },
    assignmentDescription: "Examinez le plan d’assignation avant toute écriture dans un projet.",
    installAgents: "Installer Omni pour vos agents",
    agentsButton: "Configurer les agents",
    updateAgents: "Mettre à jour Omni pour vos agents",
  },
  later: "Plus tard",
  myMarketplace: "Ma marketplace",
  centralLibrary: "Bibliothèque centrale",
  connect: "Connecter",
  projectsToWatch: "Projets à regarder",
  noProjects: "Aucun projet actif",
  noFindings: "Aucun constat dans cette session",
  projectFindings: { one: "{count} constat", other: "{count} constats" },
  actionCards: {
    audit: {
      title: "Auditer un projet",
      description: "Relancer une inspection sur un projet enregistré.",
      cta: "Lancer l’audit",
    },
    library: {
      title: "Parcourir la bibliothèque",
      description: "Inspecter les assets observés dans vos sources enregistrées.",
      cta: "Ouvrir la bibliothèque",
    },
    review: {
      title: "Examiner les constats",
      description: {
        one: "{count} constat détecté dans la session actuelle.",
        other: "{count} constats détectés dans la session actuelle.",
      },
      cta: "Ouvrir la revue",
    },
  },
  academy: {
    title: "Découvrir Omni en 4 minutes",
    description: "Un guide court sur les marketplaces, les agents et la synchronisation des projets.",
    cta: "Ouvrir Apprendre",
  },
};

export const learn = {
  heading: "Apprendre",
  description: "Cours, tutoriels et repères pour travailler avec des agents dans Omni.",
  courses: "Cours",
  coursesDescription: "Des guides de fond sur les idées derrière Omni.",
  tutorials: "Premiers pas",
  tutorialsDescription: "De courts tutoriels de quelques minutes pour commencer.",
  topics: "Par thème",
  topicsDescription: "Les concepts qui rendent le travail local avec des agents plus clair.",
  courseLabel: "Cours",
  tutorialLabel: "Tutoriel",
  minutes: "min",
  loading: "Chargement de l’Academy…",
  lessonNotFound: "Ce contenu n’est pas disponible dans la langue choisie.",
  onThisPage: "Sur cette page",
  learnMore: "En savoir plus",
  contextPanel: "Apprendre dans le contexte",
  close: "Fermer",
};

export const welcome = {
  eyebrow: "Premier lancement",
  heading: "Bienvenue dans Omni",
  description:
    "Activez votre espace local en enregistrant un projet ou une source personnelle. Omni n’affichera que l’état réel du registre.",
  projects: "{count} projet(s) actif(s)",
  sources: "{count} source(s) active(s)",
  openProjects: "Ouvrir les projets",
  openLibrary: "Ouvrir la bibliothèque",
  skip: "Passer pour l’instant",
};
