export const agentsSetup = {
  loadingItem: "Checking this agent…",
  statusUnavailable: "Omni could not read your agent installation.",
  notFound: "Not found on this Mac ({path} is missing)",
  toolServer: {
    installed: "Tool server installed",
    update: "Tool server to update",
    add: "Tool server to add",
  },
  skills: {
    installed: {
      one: "{count} skill installed",
      other: "{count} skills installed",
    },
    add: {
      one: "{count} skill to add",
      other: "{count} skills to add",
    },
    update: {
      one: "{count} skill to update",
      other: "{count} skills to update",
    },
  },
  nothingInstalled: "Nothing installed",
  foreignSkill: "{name} belongs to another skill",
  calledOmni: "called Omni {time}",
  neverCalled: "never called Omni yet",
  activityChecking: "Checking your agents…",
  activitySetup: "Set up agents…",
  activityNotDetected: "No agent folders detected",
  reviewLabel: "Omni installed for {harnesses}",
  restoreHeading: "Undo the agent installation",
  restoreDescription:
    "Restore removes the Omni skills and the Omni entry from the settings files; everything else in those files stays.",
  relative: {
    second: "{count} sec ago",
    minute: "{count} min ago",
    hour: "{count} hr ago",
  },
  need: {
    partMcp: "the tool server",
    partSkills: "skills",
    partGuard: "protection",
    and: " and ",
    description: "Adds {items}.",
    descriptionFallback: "Omni adds its tool server, skills and protection so it can work through Omni.",
  },
};
