// @vitest-environment jsdom
import { act } from "react";
import { expect, test } from "vitest";
import { ChangesDiff } from "../../src/renderer/canvas/changes/ChangesDiff";
import { ResolutionSummary } from "../../src/renderer/canvas/changes/ResolutionSummary";
import { ChangesResult } from "../../src/renderer/canvas/changes/ChangesResult";
import { parseSkillPreview, parseSkillResult } from "../../src/shared/skill-management-ipc";
import { render } from "./skill-copy-comparison-fixtures";
import { t } from "../../src/renderer/i18n";
import inputs from "../fixtures/s03-visual/resolution-inputs.json";

test("a completed inverse does not offer another restore of its inverse receipt", () => {
  const rendered = render(
    <ChangesResult result={parseSkillResult(inputs.restore.result)} t={t} onRestore={() => undefined} />,
  );
  try {
    expect(rendered.container.querySelector("button")).toBeNull();
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("canonical file effects use the existing colored diff and split controls", () => {
  const preview = parseSkillPreview(inputs.canonical.preview);
  if (preview.status !== "ready") throw new Error("Missing recorded preview.");
  const rendered = render(<ChangesDiff steps={preview.steps} t={t} />);
  try {
    expect(rendered.container.querySelector(".changes-diff-toolbar")).not.toBeNull();
    expect(rendered.container.querySelector(".changes-diff-line.is-add")).not.toBeNull();
    expect(rendered.container.querySelector(".changes-diff-line.is-remove")).not.toBeNull();
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("inverse metadata shows its actual before and after base in technical details", () => {
  const preview = parseSkillPreview(inputs.restore.preview);
  if (preview.status !== "ready") throw new Error("Missing recorded preview.");
  const step = preview.steps[0]!;
  const rendered = render(
    <ResolutionSummary variant="targets" scope={step.scope} steps={[step]} nameFor={(id) => id} />,
  );
  try {
    const transition = step.metadataEffects![0]!;
    expect(rendered.container.textContent).toContain(
      `${transition.before!.baseRevisionId} → ${transition.after!.baseRevisionId}`,
    );
    const details = rendered.container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(step.resolutionEvidence!.sourceTree!.revision.hash);
  } finally {
    act(() => rendered.root.unmount());
  }
});
