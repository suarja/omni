#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const CONTENT_ROOT = join(ROOT, "packages/omni-academy/content");
const RESOURCE_ROOT = join(ROOT, "resources/academy");
const CDP_VERSION = "1.3";
const SETTLING_TEXT = [
  "Reading project skills",
  "Loading…",
  "Loading...",
  "Not read yet",
  "Checking your agents",
  "Some locations could not be observed",
];

// Run only against a disposable, seeded demo profile with English UI. Each walk resets to
// Workspace independently. The lead supplies these fixtures through real UI operations:
// acme-skills, notes-app without web-quality, acme-workspace with review-project still local,
// detected but disconnected Codex, and a restorable import-artifact receipt from another skill.
const workspace = () => [
  { key: "Escape" },
  { key: "Escape" },
  { key: "Escape" },
  { click: "canvas-rail-home" },
  { text: "resource-canvas", containing: "Workspace" },
];
const project = (name) => [
  ...workspace(),
  { clickFirst: "canvas-entry-project-", containing: name },
  { click: "project-manage-skills" },
  { text: "project-sheet" },
];
const marketplace = () => [
  ...workspace(),
  { clickFirst: "canvas-entry-source-", containing: "acme-skills" },
  { text: "marketplace-page" },
];
const agentConfirmation = () => [
  ...workspace(),
  { click: "canvas-rail-settings" },
  { click: "settings-agent-connect-codex" },
  { text: "settings-agent-connect-confirmation" },
];
const receipt = () => [
  ...workspace(),
  { click: "canvas-rail-activity" },
  { clickFirst: "canvas-history-operation-import-artifact-" },
  { text: "receipt-page" },
  { text: "receipt-restore", enabled: true },
];

export const SCREENSHOT_WALKS = [
  {
    name: "connect-marketplace-library",
    walk: [...workspace(), { click: "canvas-setup-menu-trigger" }, { text: "canvas-setup-menu" }],
  },
  {
    name: "connect-marketplace-choose",
    walk: [
      ...workspace(),
      { click: "canvas-setup-menu-trigger" },
      { click: "canvas-setup-add-marketplace" },
      { text: "external-add-fields" },
    ],
  },
  { name: "connect-marketplace-confirm", walk: marketplace() },
  { name: "add-plugin-project", walk: project("notes-app") },
  {
    name: "add-plugin-picker",
    walk: [...project("notes-app"), { click: "project-add-skills-open" }, { text: "project-add-skills" }],
  },
  {
    name: "add-plugin-assignment",
    walk: [
      ...project("notes-app"),
      { click: "project-add-skills-open" },
      { clickFirst: "project-add-choice-", containing: "review-accessibility" },
      { clickFirst: "project-add-choice-", containing: "check-web-tests" },
      { text: "project-add-skills", containing: "Add (2)" },
    ],
  },
  { name: "capture-skill-project", walk: project("acme-workspace") },
  {
    name: "capture-skill-detail",
    walk: [
      ...project("acme-workspace"),
      { clickFirst: "project-open-skill-", containing: "review-project" },
      { text: "project-skill-sheet" },
    ],
  },
  {
    name: "capture-skill-preview",
    walk: [
      ...project("acme-workspace"),
      { clickFirst: "project-open-skill-", containing: "review-project" },
      { click: "project-capture-open" },
      { clickFirst: "plugin-picker-existing-", containing: "writing" },
      { text: "project-capture-add", enabled: true },
      { text: "project-capture" },
    ],
  },
  { name: "install-marketplace-library", walk: marketplace() },
  {
    name: "install-marketplace-menu",
    walk: [
      ...marketplace(),
      { click: "marketplace-plugins-open" },
      { clickFirst: "marketplace-plugin-menu-" },
      { text: "marketplace-plugin-menu" },
    ],
  },
  { name: "install-marketplace-harnesses", walk: project("acme-web") },
  {
    name: "install-agents-home",
    walk: [...workspace(), { click: "canvas-rail-settings" }, { text: "settings-agents" }],
  },
  { name: "install-agents-select", walk: agentConfirmation() },
  // Current setup has one summary confirmation, not a second file-diff page.
  { name: "install-agents-review", walk: agentConfirmation() },
  {
    name: "undo-review",
    walk: [...workspace(), { click: "canvas-rail-activity" }, { text: "canvas-history-sheet" }],
  },
  { name: "undo-receipt", walk: receipt() },
  {
    name: "undo-restore",
    walk: [...receipt(), { click: "receipt-restore" }, { text: "restore-apply", enabled: true }],
  },
].map((entry) => ({ viewport: { width: 1440, height: 900 }, language: "en", ...entry }));

// Only controls inspected as navigation, selection or preview openers belong here.
// Final Add/Connect/Restore controls may be read for readiness, never clicked.
export const SAFE_CLICKS = new Set([
  "canvas-rail-home",
  "canvas-rail-settings",
  "canvas-rail-activity",
  "canvas-setup-menu-trigger",
  "canvas-setup-add-marketplace",
  "project-manage-skills",
  "project-add-skills-open",
  "project-capture-open",
  "marketplace-plugins-open",
  "settings-agent-connect-codex",
  "receipt-restore",
]);
export const SAFE_CLICK_PREFIXES = new Set([
  "canvas-entry-project-",
  "canvas-entry-source-",
  "project-add-choice-",
  "project-open-skill-",
  "plugin-picker-existing-",
  "marketplace-plugin-menu-",
  "canvas-history-operation-import-artifact-",
]);

export function validateWalks(walks) {
  const names = new Set();
  for (const entry of walks) {
    if (names.has(entry.name)) throw new Error(`Duplicate Academy walk: ${entry.name}`);
    names.add(entry.name);
    for (const action of entry.walk) {
      const kinds = ["click", "clickFirst", "text", "key"].filter((kind) => kind in action);
      if (kinds.length !== 1 || ("key" in action && action.key !== "Escape"))
        throw new Error(`Unsupported Academy action in ${entry.name}`);
      if ("click" in action && !SAFE_CLICKS.has(action.click))
        throw new Error(`Unsafe Academy click in ${entry.name}: ${action.click}`);
      if ("clickFirst" in action && !SAFE_CLICK_PREFIXES.has(action.clickFirst))
        throw new Error(`Unsafe Academy click prefix in ${entry.name}: ${action.clickFirst}`);
      if (!("click" in action || "clickFirst" in action || "text" in action || action.key === "Escape"))
        throw new Error(`Unsupported Academy action in ${entry.name}`);
    }
  }
}

async function contentFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await contentFiles(file)));
    else if (entry.name.endsWith(".md")) files.push(file);
  }
  return files;
}

async function referencedNames() {
  const names = new Set();
  for (const file of await contentFiles(CONTENT_ROOT)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\[screenshot:([a-z0-9-]+)\]/g)) names.add(match[1]);
  }
  return names;
}

async function check() {
  validateWalks(SCREENSHOT_WALKS);
  const referenced = await referencedNames();
  const missing = [...referenced].filter((name) => !SCREENSHOT_WALKS.some((walk) => walk.name === name));
  for (const walk of SCREENSHOT_WALKS) {
    if (referenced.has(walk.name)) {
      try {
        await readFile(join(RESOURCE_ROOT, `${walk.name}.png`));
      } catch {
        missing.push(walk.name);
      }
    }
  }
  if (missing.length) {
    process.stderr.write(`Missing Academy screenshots: ${[...new Set(missing)].sort().join(", ")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Academy screenshots present: ${referenced.size}\n`);
}

async function connect() {
  const targets = await (await fetch("http://127.0.0.1:9334/json/list")).json();
  const target = targets.find((candidate) => candidate.webSocketDebuggerUrl);
  if (!target) throw new Error("No CDP page is available on port 9334.");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const onMessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        socket.removeEventListener("message", onMessage);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { command, close: () => socket.close() };
}

async function capture() {
  validateWalks(SCREENSHOT_WALKS);
  await mkdir(RESOURCE_ROOT, { recursive: true });
  const cdp = await connect();
  try {
    for (const entry of SCREENSHOT_WALKS) {
      await cdp.command("Emulation.setDeviceMetricsOverride", {
        width: entry.viewport.width,
        height: entry.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const action of entry.walk) {
        if ("key" in action) {
          await cdp.command("Input.dispatchKeyEvent", { type: "keyDown", key: action.key });
          await cdp.command("Input.dispatchKeyEvent", { type: "keyUp", key: action.key });
          continue;
        }
        const selector =
          "clickFirst" in action
            ? `[data-testid^="${action.clickFirst}"]`
            : `[data-testid="${"click" in action ? action.click : action.text}"]`;
        // The app renders asynchronously after a click: poll for the element up to five seconds.
        const expression = `(async () => {
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(
              (candidate) => !${JSON.stringify(action.containing ?? "")} || candidate.textContent.includes(${JSON.stringify(action.containing ?? "")}),
            );
            if (element && !element.closest('[inert], [hidden]') && element.getClientRects().length &&
                !element.matches(':disabled') && (!${Boolean(action.enabled)} || !element.hasAttribute('disabled'))) {
              element.scrollIntoView({ block: 'nearest' });
              return ${"text" in action ? "element.textContent" : "(element.click(), 'clicked')"};
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error(${JSON.stringify(`Missing test id: ${selector}`)});
        })()`;
        const result = await cdp.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "walk failed");
        if ("text" in action)
          process.stdout.write(`${entry.name}: ${String(result.result?.value ?? "").slice(0, 80)}\n`);
      }
      // Capture settled pages only: wait (up to ten seconds) until no loading text is visible.
      await cdp.command("Runtime.evaluate", {
        expression: `(async () => {
          const busy = ${JSON.stringify(SETTLING_TEXT)};
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (!busy.some((text) => document.body.innerText.includes(text))) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        })()`,
        awaitPromise: true,
      });
      await cdp.command("Runtime.evaluate", {
        expression:
          "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))",
        awaitPromise: true,
      });
      const image = await cdp.command("Page.captureScreenshot", { format: "png" });
      await writeFile(join(RESOURCE_ROOT, `${entry.name}.png`), Buffer.from(image.data, "base64"));
      process.stdout.write(`Captured ${entry.name}.png at 1440x900\n`);
    }
  } finally {
    cdp.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes("--check")) await check();
  else
    await capture().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

export { CDP_VERSION };
