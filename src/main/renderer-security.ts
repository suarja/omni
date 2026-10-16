import { pathToFileURL } from "node:url";

export type RendererPolicy = Readonly<{
  developmentUrl?: string;
  developmentOrigin?: string;
  packagedUrl: string;
}>;

export function resolveDevelopmentUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  const url = new URL(rawUrl);
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "http:" || !localHosts.has(url.hostname)) {
    throw new Error("ELECTRON_RENDERER_URL must point to a local HTTP origin.");
  }
  return url.toString();
}

export function createRendererPolicy(rendererPath: string): RendererPolicy {
  const developmentUrl = resolveDevelopmentUrl(process.env.ELECTRON_RENDERER_URL);
  return {
    developmentUrl,
    developmentOrigin: developmentUrl ? new URL(developmentUrl).origin : undefined,
    packagedUrl: pathToFileURL(rendererPath).toString(),
  };
}

export function isTrustedRendererUrl(url: string, policy: RendererPolicy): boolean {
  if (policy.developmentOrigin) {
    try {
      return new URL(url).origin === policy.developmentOrigin;
    } catch {
      return false;
    }
  }
  return url === policy.packagedUrl;
}

export function assertTrustedSender(event: Electron.IpcMainInvokeEvent, policy: RendererPolicy): void {
  const senderFrame = event.senderFrame;
  if (!senderFrame || senderFrame !== event.sender.mainFrame || !isTrustedRendererUrl(senderFrame.url, policy)) {
    throw new Error("Rejected IPC request from an untrusted renderer.");
  }
}
