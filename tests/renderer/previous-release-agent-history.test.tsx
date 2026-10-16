import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { parseAgentRequestResponse, type AgentRequest } from "../../src/shared/agents-ipc";
import { I18nProvider, useI18n } from "../../src/renderer/i18n";
import { AgentRequestRow } from "../../src/renderer/review/agent-requests";

function HistoryRows({ requests }: Readonly<{ requests: readonly AgentRequest[] }>): React.ReactElement {
  const { t } = useI18n();
  return (
    <>
      {requests.map((request) => (
        <AgentRequestRow key={request.requestId} request={request} t={t} />
      ))}
    </>
  );
}

it("displays three rc.9 capture records loaded from disk through the preload parser", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-previous-release-display-"));
  try {
    await mkdir(join(root, "omni"));
    const path = join(root, "omni/agent-requests.json");
    await copyFile(join(import.meta.dirname, "../fixtures/persisted-state/rc9/agent-requests.json"), path);
    const store = createAgentRequestsStore(path, () => Date.parse("2026-10-11T12:00:00.000Z"));
    const response = parseAgentRequestResponse({ status: "ready", requests: await store.all() });
    const html = renderToStaticMarkup(
      <I18nProvider initialLanguage="en">
        <HistoryRows requests={response.requests} />
      </I18nProvider>,
    );
    for (const index of [1, 2, 3]) {
      expect(html).toContain(`agent-request-capture-${index}`);
      expect(html).toContain(`.claude/skills/release-check-${index}`);
      expect(html).toContain(`Codex · release-session-${index}`);
    }
    expect(html).not.toContain("undefined");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
