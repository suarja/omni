// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { expect, test, vi } from "vitest";

import type { Observation } from "../../src/domain/project-source-registry";
import { useOwnedSkillChoices } from "../../src/renderer/canvas/use-owned-skill-choices";
import { I18nProvider } from "../../src/renderer/i18n";
import { resourceFixture, snapshot } from "../fixtures/resource-catalogue";
import { deferred, render } from "./skill-copy-comparison-fixtures";

function unobservedSourceSnapshot() {
  return {
    ...snapshot,
    roots: snapshot.roots.map((root) =>
      root.entry.kind === "source" ? { entry: root.entry, evidence: { status: "unobserved" as const } } : root,
    ),
  };
}

function emptySourceObservation(): Observation {
  return {
    ...resourceFixture.sourceObservation,
    inventory: { ...resourceFixture.sourceObservation.inventory, artifacts: [], packages: [] },
  };
}

function ChoiceView(
  props: Readonly<{
    contextKey: string;
    observe: (sourceId: string, isCurrent: () => boolean) => Promise<Observation | null>;
    chosen: (value: string) => void;
  }>,
): ReactElement {
  const choices = useOwnedSkillChoices(unobservedSourceSnapshot(), props.observe, props.contextKey);
  return (
    <I18nProvider>
      <label>
        <span>Marketplace skill</span>
        <select
          aria-label="Marketplace skill"
          onChange={(event) => {
            choices.selectChoice(event.target.value);
            if (choices.choices.some((choice) => choice.value === event.target.value)) props.chosen(event.target.value);
          }}
          value={choices.selectedValue}
        >
          <option value="">Choose a marketplace skill</option>
          {choices.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p role="status">{choices.status}</p>
      {choices.unavailableSourceId ? <button onClick={choices.retrySource}>Retry source</button> : null}
    </I18nProvider>
  );
}

test("a late source observation cannot select a skill after the target context changes", async () => {
  const pending = deferred<Observation | null>();
  const observe = vi.fn((_sourceId: string, _isCurrent: () => boolean) => pending.promise);
  const chosen = vi.fn();
  const rendered = render(<ChoiceView contextKey="target-one" observe={observe} chosen={chosen} />);
  try {
    const select = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Marketplace skill"]')!;
    await act(async () => {
      select.value = "load:source-one";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe("loading");
    expect(chosen).not.toHaveBeenCalled();

    await act(async () => {
      rendered.root.render(
        <I18nProvider>
          <ChoiceView contextKey="target-two" observe={observe} chosen={chosen} />
        </I18nProvider>,
      );
    });
    await act(async () => {
      pending.resolve(resourceFixture.sourceObservation);
      await pending.promise;
    });

    expect(rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Marketplace skill"]')?.value).toBe(
      "",
    );
    expect(chosen).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Load skills from Personal Skills");
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("unavailable and empty source catalogues stay distinct and require an explicit skill choice", async () => {
  const observe = vi
    .fn<(sourceId: string, isCurrent: () => boolean) => Promise<Observation | null>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(emptySourceObservation());
  const chosen = vi.fn();
  const rendered = render(<ChoiceView contextKey="target" observe={observe} chosen={chosen} />);
  try {
    const select = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Marketplace skill"]')!;
    await act(async () => {
      select.value = "load:source-one";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => Promise.resolve());
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe("unavailable");
    expect(chosen).not.toHaveBeenCalled();

    const retry = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Retry source",
    );
    await act(async () => retry?.click());
    await act(async () => Promise.resolve());
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe("empty");
    expect(rendered.container.querySelectorAll('option[value^="["]').length).toBe(0);
    expect(chosen).not.toHaveBeenCalled();
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("packages without eligible skills report an empty catalogue", async () => {
  const observation = {
    ...resourceFixture.sourceObservation,
    inventory: { ...resourceFixture.sourceObservation.inventory, artifacts: [] },
  };
  const rendered = render(
    <ChoiceView contextKey="empty-packages" observe={async () => observation} chosen={vi.fn()} />,
  );
  try {
    await act(async () => {
      const select = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Marketplace skill"]')!;
      select.value = "load:source-one";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe("empty");
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("an already observed source with packages but no skills is empty before selection", () => {
  function EmptyCatalogue(): ReactElement {
    const observed = {
      ...snapshot,
      roots: snapshot.roots.map((root) =>
        root.entry.kind === "source" && root.evidence.status === "observed"
          ? {
              ...root,
              evidence: {
                ...root.evidence,
                observation: {
                  ...root.evidence.observation,
                  inventory: { ...root.evidence.observation.inventory, artifacts: [] },
                },
              },
            }
          : root,
      ),
    };
    const choices = useOwnedSkillChoices(observed, undefined, "empty-catalogue");
    return <p role="status">{choices.status}</p>;
  }
  const view = render(<EmptyCatalogue />);
  try {
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe("empty");
  } finally {
    act(() => view.root.unmount());
  }
});
