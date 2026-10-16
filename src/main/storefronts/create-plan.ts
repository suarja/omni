import { publicRepositoryUrl, resolveRepositoryPushUrl } from "../git-push";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { checkPublication } from "../../domain/publish-checks";
import { githubRepository } from "../../domain/storefront-origin";
import type { NewStorefront } from "../../shared/publication-operations-ipc";
import type { OperationPlan } from "../../shared/operations-ipc";
import { systemGhCli } from "../gh-cli";
import { hashContent, json } from "../marketplace-manifests";
import { context, hashes, rootIdentity, type FileTree, type PublicationOptions } from "./publish-context";
import { storefrontLicense } from "./license-texts";
export type CreateStored = Readonly<{
  plan: OperationPlan;
  input: NewStorefront;
  root: string;
  sourceId: string;
  login: string;
  remoteUrl: string;
  usesGh: boolean;
  files: FileTree;
  fingerprint: string;
  operationId: string;
}>;
export async function buildCreatePlan(
  options: PublicationOptions,
  input: NewStorefront,
  sourceId: string = randomUUID(),
  operationId: string = randomUUID(),
): Promise<CreateStored> {
  const ctx = await context(options);
  const gh = options.gh ?? systemGhCli;
  const parent = await realpath(dirname(dirname(ctx.workshopRoot)));
  const root = join(parent, input.name);
  const exists = await lstat(root).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (exists) throw new Error("The proposed storefront folder already exists. Choose a new folder name.");
  const usesGh = !input.repositoryUrl;
  const authenticated = usesGh && (await gh.available()) ? await gh.login() : undefined;
  if (usesGh && !authenticated)
    throw new Error(
      "GitHub CLI is unavailable or unauthenticated. Provide an existing repository URL and its GitHub login.",
    );
  if (authenticated && input.login && input.login !== authenticated)
    throw new Error("The requested GitHub login differs from the authenticated owner.");
  const login = authenticated || input.login;
  if (!login) throw new Error("Provide the GitHub login for the license holder and installation instructions.");
  if (!(await options.git.isGitAvailable()))
    throw new Error("Git is unavailable. Install Git before creating a storefront.");
  const remoteUrl = await resolveRepositoryPushUrl(
    parent,
    input.repositoryUrl ?? `https://github.com/${login}/${input.name}.git`,
  );
  const sentence = input.description ?? "Public plugins maintained in a private workshop marketplace.";
  const repository =
    githubRepository(remoteUrl) ?? githubRepository(publicRepositoryUrl(remoteUrl)) ?? `${login}/${input.name}`;
  const readme = `# ${input.name}\n\n${sentence}\n\n## Plugins\n\n<!-- omni:plugins -->\n<!-- /omni:plugins -->\n\n## Install\n\n### Claude Code\n\nAdd the marketplace:\n\n\`\`\`text\n/plugin marketplace add ${repository}\n\`\`\`\n\nInstall a listed plugin with \`/plugin install plugin-name@${input.name}\`.\n\n### Codex\n\nAdd \`https://github.com/${repository}\` as a plugin marketplace and select a listed plugin.\n`;
  const files: FileTree = Object.fromEntries(
    Object.entries({
      "README.md": readme,
      LICENSE: storefrontLicense(input.license, new Date((options.now ?? Date.now)()).getUTCFullYear(), login),
      ".claude-plugin/marketplace.json": json({ name: input.name, owner: { name: login }, plugins: [] }),
      ".agents/plugins/marketplace.json": json({ name: input.name, owner: { name: login }, plugins: [] }),
    }).map(([path, content]) => [path, Buffer.from(content)]),
  );
  const findings = checkPublication({
    files: Object.entries(files).map(([path, content]) => ({ path, content: Buffer.from(content).toString("utf8") })),
    hasLicense: true,
    homeDirectory: options.homeDirectory ?? homedir(),
  });
  const fingerprint = hashContent(
    JSON.stringify({
      revision: ctx.revision,
      workshopId: ctx.workshop.id,
      workshopIdentity: await rootIdentity(ctx.workshopRoot),
      parentIdentity: await rootIdentity(parent),
      input,
      login,
      usesGh,
      remoteUrl,
      files: hashes(files),
    }),
  );
  const plan: OperationPlan = {
    planId: randomUUID(),
    kind: "create-storefront",
    displayTarget: input.name,
    actions: Object.entries(files).map(([relativePath, bytes]) => ({
      kind: "write-file",
      relativePath,
      byteLength: bytes.byteLength,
      afterHash: hashContent(bytes),
    })),
    git: { mode: "init-and-commit", warnings: [] },
    findings: findings.map(({ severity, code, message, fix }) => ({ severity, code, message, fix })),
    publication: { approvalFingerprint: fingerprint, files: [], conflicts: [], findings: [...findings] },
    notes: [
      `Create the storefront folder ${input.name} next to the workshop's parent.`,
      usesGh
        ? `Create and push the public GitHub repository ${login}/${input.name}.`
        : "Set the supplied repository URL as origin and push the initial commit.",
    ],
  };
  return { plan, input, root, sourceId, login, remoteUrl, usesGh, files, fingerprint, operationId };
}
