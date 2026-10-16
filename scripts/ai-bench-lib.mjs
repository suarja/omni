export function overlapPercentage(picks, deterministicTopFive) {
  const picked = new Set(picks.map(modelKey).filter(Boolean));
  const baseline = new Set(deterministicTopFive.map(modelKey).filter(Boolean));
  if (baseline.size === 0) return 0;
  return Math.round(([...picked].filter((key) => baseline.has(key)).length / baseline.size) * 100);
}

export function reasonLanguage(reasons) {
  const text = reasons.join(" ").toLowerCase();
  const french = (text.match(/\b(?:le|la|les|pour|avec|dans|une|des|ce|cette|qui)\b/g) ?? []).length;
  const english = (text.match(/\b(?:the|for|with|from|this|that|which|fits)\b/g) ?? []).length;
  if (french === 0 && english === 0) return "unknown";
  return french > english ? "fr" : "en";
}

export function formatBenchmarkTable(rows) {
  const headers = [
    "Model",
    "Valid output",
    "Suggest overlap",
    "Reasons",
    "Latency",
    "Tokens in/out",
    "Cost",
    "Compose",
    "Why not",
  ];
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (row) =>
        `| ${[row.model, row.valid, row.overlap, row.reasons, row.latency, row.tokens, row.cost, row.compose, row.why]
          .map((value) => escapeCell(value ?? "—"))
          .join(" | ")} |`,
    ),
  ];
  return lines.join("\n");
}

function modelKey(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const ownerRepo = typeof value.ownerRepo === "string" ? value.ownerRepo : "";
  const skill = typeof value.skill === "string" ? value.skill : "";
  return ownerRepo && skill ? `${ownerRepo}/${skill}` : typeof value.id === "string" ? value.id : "";
}

function escapeCell(value) {
  return String(value)
    .replaceAll("|", "\\|")
    .replace(/[\r\n]+/g, " ");
}
