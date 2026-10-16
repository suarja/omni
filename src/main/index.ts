import { createExternalLibraryUiAdapter } from "./external-library/ui-adapter";
import { registerExternalLibraryUiIpc } from "./external-library/ui-ipc";
import { createAgentMaintenance, registerAgentMaintenanceIpc } from "./agent-maintenance";
import { createExternalLibraryScheduler } from "./external-library/scheduler";
import { registerExternalLibraryIpc } from "./external-library/ipc";
import { watchReviewChanges } from "./review-events";
import { REVIEW_CHANGED_CHANNEL } from "../shared/review-events";
import { shell, app, BrowserWindow, Notification, safeStorage } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerRegistryIpcHandlers } from "./registry-ipc";
import { registerStorefrontIpcHandlers } from "./storefronts/ipc";
import { registerArtifactIpcHandlers } from "./artifact-ipc";
import { registerIdentityIpcHandlers } from "./identity-ipc";
import { registerSkillReconciliationIpcHandlers } from "./skill-reconciliation/ipc";
import { registerOperationsIpcHandlers } from "./operations-ipc";
import { registerBindingsIpcHandlers } from "./bindings-ipc";
import { registerActivityIpcHandlers } from "./activity-ipc";
import { registerApplyIpcHandlers } from "./apply-ipc";
import { registerStackProfileIpcHandlers } from "./stack-profile-ipc";
import { registerCatalogueIpcHandlers } from "./catalogue/ipc";
import { registerSettingsIpcHandlers } from "./settings-ipc";
import { registerAcademyIpcHandlers } from "./academy/ipc";
import { registerInferenceIpcHandlers } from "./inference/ipc";
import { createLoginItemService } from "./login-item";
import { registerLoginItemIpcHandlers } from "./login-item-ipc";
import { startMainWindow, activateMainWindow } from "./startup-window";
import { createSettingsStore, settingsFilePath } from "./settings-store";
import { createElectronAppUpdates } from "./app-updates/electron-adapter";
import { registerAppUpdatesIpc } from "./app-updates/ipc";
import { APP_UPDATE_CHANNELS } from "../shared/app-updates-ipc";
import { createKeyStore, inferenceKeysFilePath } from "./inference/keys";
import { createBudget, inferenceLogFilePath } from "./inference/budget";
import { listModels } from "./inference/gateway/models";
import { createAgentJobRunner } from "./agents/runner";
import { registerAgentJobIpcHandlers } from "./agents/ipc";
import { registerAgentIpcHandlers } from "./agent-gateway/ipc";
import { createAgentGateway } from "./agent-gateway/server";
import { createAgentRouter } from "./agent-gateway/router";
import { AGENTS_IPC_CHANNELS } from "../shared/agents-ipc";
import { watchAgentRequestAttention } from "./agent-gateway/request-attention";
import { showAgentRequestWindow } from "./agent-gateway/request-window";
import { createAgentRequestsStore } from "./agent-gateway/requests-store";
import { createAgentTokenManager } from "./agent-gateway/auth";
import { createLastSeenStore } from "./agent-gateway/last-seen-store";
import { ensureOmniMcpRuntime, writeDesktopManifest } from "./omni-mcp-runtime";
import { ensureOmniGuardRuntime } from "./omni-guard-runtime";
import { registerGuardIpcHandlers, refreshGuardConfig } from "./guard-ipc";
import { resolveResource } from "./omni-resources";
import { createOperationStore } from "./operation-store";
import { createActivitySnapshotReader } from "./activity-snapshot";
import { createAgentClientIdentityResolver } from "./agent-client-identity";
import { disposeSharedIsolatedDirectoryReader } from "./isolated-directory-reader";
import { createPlatform } from "./platform";
import { loadBuildIdentity, resolveProfilePolicy } from "./runtime-identity";
import {
  assertTrustedSender,
  createRendererPolicy,
  isTrustedRendererUrl,
  type RendererPolicy,
} from "./renderer-security";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const profilePolicy = resolveProfilePolicy({ isPackaged: app.isPackaged });
app.setPath("userData", profilePolicy.profilePath);
if (!app.isPackaged && typeof app.setName === "function") app.setName("Omni Desktop (Development)");

const hasSingleInstance = app.requestSingleInstanceLock();
let mainWindow: BrowserWindow | undefined;

function createWindow(policy: RendererPolicy): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#fbfaf9",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 24 },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.OMNI_RECEPTION_TRACE === "1") {
    window.webContents.on("console-message", (_event, _level, message) => {
      if (message.startsWith("[omni-reception]")) console.info(message);
    });
  }

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, policy)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedRendererUrl(url, policy)) {
      event.preventDefault();
    }
  });

  if (policy.developmentUrl) {
    void window.loadURL(policy.developmentUrl).catch((error: unknown) => {
      console.error("Failed to load the development renderer.", error);
    });
  } else {
    void window.loadFile(fileURLToPath(policy.packagedUrl)).catch((error: unknown) => {
      console.error("Failed to load the packaged renderer.", error);
    });
  }

  return window;
}

if (!hasSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

void (hasSingleInstance
  ? app
      .whenReady()
      .then(async () => {
        const appPath = typeof app.getAppPath === "function" ? app.getAppPath() : process.cwd();
        const build = await loadBuildIdentity({
          appRoot: appPath,
          isPackaged: app.isPackaged,
          fallbackVersion: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
        });
        if (process.platform === "darwin" && typeof app.setAboutPanelOptions === "function") {
          app.setAboutPanelOptions({
            applicationName: app.isPackaged ? "Omni Desktop" : "Omni Desktop (Development)",
            applicationVersion: build.version,
            version: `${build.channel} · ${build.commit}`,
          });
        }
        const rendererPath = join(__dirname, "../renderer/index.html");
        const policy = createRendererPolicy(rendererPath);
        const assertSender = (event: Electron.IpcMainInvokeEvent): void => assertTrustedSender(event, policy);
        const platform = createPlatform();
        const userDataPath = profilePolicy.profilePath;
        const grants = registerRegistryIpcHandlers(assertSender);
        registerStorefrontIpcHandlers(assertSender, { userDataPath });
        registerArtifactIpcHandlers(assertSender, grants);
        registerIdentityIpcHandlers(assertSender, grants);
        registerSkillReconciliationIpcHandlers(assertSender, grants, { userDataPath });
        const mcpRuntimePath = await ensureOmniMcpRuntime({
          userDataPath,
          sourcePath: resolveResource(join("plugins", "omni", "runtime", "omni-mcp.mjs"), {
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            appPath: typeof app.getAppPath === "function" ? app.getAppPath() : process.cwd(),
          }),
        });
        await writeDesktopManifest({
          userDataPath,
          version: build.version,
          build,
          profilePath: userDataPath,
          appPath,
          ...(mcpRuntimePath ? { runtimePath: mcpRuntimePath } : {}),
        });
        // One receipts store per process: every writer (operations, apply engine, activity, agent gateway)
        // shares it, so no instance ever appends over another's receipts from a stale cache.
        const operationStore = createOperationStore(join(userDataPath, "omni", "operations.json"));
        const requests = createAgentRequestsStore(join(userDataPath, "omni", "agent-requests.json"));
        const applyRestore = registerApplyIpcHandlers(assertSender, grants, { operationStore });
        const bindings = registerBindingsIpcHandlers(assertSender, grants);
        const operations = registerOperationsIpcHandlers(assertSender, grants, {
          operationStore,
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath,
          applyRestore,
          bindings,
          agentRequests: requests,
          onSkillProgress: () => {
            for (const window of BrowserWindow.getAllWindows()) {
              if (!window.isDestroyed()) window.webContents.send(REVIEW_CHANGED_CHANNEL);
            }
          },
        });
        await operations.skillManagement.initialize();
        const settingsStore = createSettingsStore(settingsFilePath(userDataPath));
        const appUpdates = createElectronAppUpdates({
          appRoot: appPath,
          userDataPath,
          policy: {
            isPackaged: app.isPackaged,
            channel: build.channel,
            profileSource: profilePolicy.source,
            signing: build.signing ?? "ad-hoc-local-only",
            platform: process.platform,
            test: process.env.NODE_ENV === "test" || process.env.VITEST === "true",
          },
          changed: (state) => {
            for (const window of BrowserWindow.getAllWindows()) {
              if (!window.isDestroyed()) window.webContents.send(APP_UPDATE_CHANNELS.changed, state);
            }
          },
        });
        registerAppUpdatesIpc(assertSender, appUpdates);
        void appUpdates.initialize();
        const loginItem = createLoginItemService({
          store: settingsStore,
          os: app,
          platform: process.platform,
          isPackaged: app.isPackaged,
          channel: build.channel,
          profileSource: profilePolicy.source,
        });
        const wasOpenedAtLogin = loginItem.wasOpenedAtLogin();
        await loginItem
          .initialize()
          .catch((error: unknown) =>
            console.error("Could not register Omni at login. Check Settings or macOS System Settings.", error),
          );
        registerLoginItemIpcHandlers(assertSender, loginItem);
        const keyStore = createKeyStore(inferenceKeysFilePath(userDataPath), safeStorage);
        const budget = createBudget({ logFilePath: inferenceLogFilePath(userDataPath) });
        registerSettingsIpcHandlers(assertSender, { userDataPath, settingsStore });
        // The guard (Brief B1): materialize the script so its hook command path is stable across
        // updates, register the warn-switch IPC, and refresh guard.json once so it reflects the
        // current registry and settings from the very first launch after this change.
        await ensureOmniGuardRuntime({
          userDataPath,
          sourcePath: resolveResource(join("resources", "guard", "omni-guard.mjs"), {
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            appPath: typeof app.getAppPath === "function" ? app.getAppPath() : process.cwd(),
          }),
        });
        registerGuardIpcHandlers(assertSender, { userDataPath, settingsStore });
        await refreshGuardConfig({ userDataPath, settingsStore }).catch((error: unknown) => {
          console.error("Failed to refresh guard.json at startup.", error);
        });
        registerAcademyIpcHandlers(assertSender, { userDataPath });
        registerStackProfileIpcHandlers(assertSender, grants, { userDataPath });
        registerCatalogueIpcHandlers(assertSender, grants, { userDataPath });
        registerInferenceIpcHandlers(assertSender, grants, { userDataPath, settingsStore, keyStore, budget });
        const tokenManager = createAgentTokenManager(userDataPath);
        const lastSeen = createLastSeenStore(userDataPath);
        let readJobSessions: () => readonly import("../shared/activity-ipc").AgentSession[] = () => [];
        const activitySnapshot = createActivitySnapshotReader({
          userDataPath,
          platform,
          omniPid: process.pid,
          jobSessions: () => readJobSessions(),
        });
        const router = createAgentRouter({
          userDataPath,
          registry: grants,
          operations,
          bindings,
          requests,
          operationStore,
          appVersion: build.version,
          build,
          profilePath: userDataPath,
          appPath,
          activitySnapshot,
        });
        const gateway = createAgentGateway({
          userDataPath,
          tokenManager,
          platform,
          router,
          identifyClient: createAgentClientIdentityResolver({ platform, omniPid: process.pid }),
          onClientIdentified: async (client) => {
            // Unidentified callers do not name their harness today, so they record nothing.
            if (client.harness) await lastSeen.record(client.harness);
          },
        });
        const jobs = createAgentJobRunner({
          router,
          registry: grants,
          budget,
          getConnection: async () => (await settingsStore.read()).ai.connection,
          readKey: async () => {
            const connection = (await settingsStore.read()).ai.connection;
            return connection ? keyStore.readKey(connection.preset) : undefined;
          },
          getModels: (connection) => listModels(connection, { readKey: () => keyStore.readKey(connection.preset) }),
          // Read at each start, never a snapshot: the user changes the Compose model in Settings.
          getFunctions: async () => (await settingsStore.read()).ai.functions,
          appVersion: build.version,
        });
        readJobSessions = jobs.activitySessions;
        registerActivityIpcHandlers(assertSender, {
          operationStore,
          platform,
          activitySnapshot,
          jobSessions: jobs.activitySessions,
        });
        registerAgentJobIpcHandlers(assertSender, jobs);
        registerAgentIpcHandlers(assertSender, {
          requests,
          refreshAgentRequest: router.refreshAgentRequest,
          tokenManager,
          socketPath: gateway.socketPath,
          userDataPath,
          lastSeen,
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath,
          appVersion: build.version,
        });
        const stopReviewNotifications = watchReviewChanges(userDataPath, () => {
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.send(REVIEW_CHANGED_CHANNEL);
          }
        });
        const stopRequestAttention = await watchAgentRequestAttention({
          requests,
          app,
          isFocused: () => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused()),
          createNotification: (options) => new Notification(options),
          openRequest: (requestId) => {
            mainWindow = showAgentRequestWindow(
              mainWindow,
              () => createWindow(policy),
              (window) => {
                window.webContents.send(AGENTS_IPC_CHANNELS.openRequest, { requestId });
              },
            );
          },
        });
        const maintenance = createAgentMaintenance({
          userDataPath,
          version: build.version,
          settingsStore,
          operationStore,
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath,
          onChanged: () => {
            for (const window of BrowserWindow.getAllWindows()) {
              if (!window.isDestroyed()) window.webContents.send(REVIEW_CHANGED_CHANNEL);
            }
          },
        });
        registerAgentMaintenanceIpc(assertSender, maintenance);
        const externalLibrary = operations.externalLibrary!;
        const externalScheduler = createExternalLibraryScheduler(externalLibrary);
        registerExternalLibraryIpc(assertSender, externalLibrary);
        registerExternalLibraryUiIpc(
          assertSender,
          createExternalLibraryUiAdapter({
            library: externalLibrary,
            grants,
            openRepository: (url) => shell.openExternal(url),
          }),
        );
        await gateway.start();
        app.once("before-quit", (event) => {
          event.preventDefault();
          stopReviewNotifications();
          appUpdates.dispose();
          stopRequestAttention();
          externalScheduler.stop();
          void Promise.allSettled([gateway.stop(), disposeSharedIsolatedDirectoryReader()]).then(() => app.quit());
        });
        mainWindow = startMainWindow({ wasOpenedAtLogin, create: () => createWindow(policy) });
        mainWindow.webContents.once("did-finish-load", () => {
          void externalScheduler
            .start()
            .catch((error: unknown) => console.error("External library check failed.", error));
        });
        void maintenance.start().catch((error: unknown) => console.error("Automatic agent update failed.", error));

        app.on("activate", () => {
          mainWindow = activateMainWindow(mainWindow, () => createWindow(policy));
        });
      })
      .catch((error: unknown) => {
        console.error("Omni Desktop failed to start.", error);
        app.quit();
      })
  : Promise.resolve());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
