import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import type { EntryRef } from "../../../domain/project-source-registry";
import { parseReadArtifactResponse } from "../../../shared/artifact-ipc";
import { AssetContent } from "../../assets/AssetContent";
import { useI18n } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { SheetFrame } from "../SheetFrame";
import { useResourceDocument } from "../use-resource-document";

type DocumentOrigin = Readonly<{ entry: EntryRef; path: string }> | Readonly<{ sourceId: string; skillPath: string }>;
export function SkillDocumentPreview(
  props: Readonly<{ name: string; description?: string; origin?: DocumentOrigin }>,
): ReactElement {
  const rail = useCanvasRail()!;
  const { t } = useI18n();
  const [full, setFull] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const document = useResourceDocument({ api: rail.canvas.api, onEnsureGrant: rail.canvas.onEnsureGrant });
  const response = document.state.status === "result" ? document.state.document.response : undefined;
  function close(): void {
    generation.current++;
    setFull(false);
    document.cancel();
    trigger.current?.closest(".canvas-sheet")?.removeAttribute("inert");
    trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!full) return;
    const reader = trigger.current?.closest(".canvas-sheet");
    reader?.setAttribute("inert", "");
    return () => reader?.removeAttribute("inert");
  }, [full]);
  useEffect(() => {
    if (!full) return;
    const key = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape" &&
        !(event.altKey && event.key === "ArrowLeft") &&
        !(event.metaKey && event.key === "[")
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [full]);
  async function read(): Promise<void> {
    if (!props.origin || !rail.canvas.api) return;
    const ticket = ++generation.current;
    setExternalDocument(undefined);
    setFull(true);
    setError(null);
    if ("entry" in props.origin) {
      document.read(props.origin.entry, props.origin.path);
      return;
    }
    try {
      if (!rail.canvas.api.readExternalSkillDocument)
        throw new Error("Source reading is unavailable. Reopen the library.");
      const raw = parseReadArtifactResponse(await rail.canvas.api.readExternalSkillDocument(props.origin));
      if (ticket === generation.current) setExternalDocument(raw);
    } catch (failure) {
      if (ticket === generation.current)
        setError(
          failure instanceof Error ? failure.message : "The source skill could not be read. Retry from its page.",
        );
    }
  }
  const [externalDocument, setExternalDocument] = useState<typeof response>();
  const content = props.origin && "sourceId" in props.origin ? externalDocument : response;
  const layer = trigger.current?.closest(".canvas-rail-layer");
  return (
    <>
      <section className="external-section">
        <h3>SKILL.md</h3>
        <pre className="page-skill-md">{`---\nname: ${props.name}\ndescription: ${props.description ?? ""}\n---`}</pre>
        <button
          ref={trigger}
          className="canvas-secondary-button is-small is-ghost"
          type="button"
          disabled={!props.origin}
          onClick={() => void read()}
        >
          {t("externalLibrary.readEntireSkill")}
        </button>
        <span className="skill-hint">
          {props.origin
            ? "entry" in props.origin
              ? props.origin.path
              : `${props.origin.sourceId} › ${props.origin.skillPath}`
            : ""}
        </span>
      </section>
      {full && layer
        ? createPortal(
            <SheetFrame
              title={props.name}
              kicker="SKILL.md"
              testId="page-skill-document"
              resizeKind="document"
              onClose={close}
            >
              {error ? (
                <p role="alert">{error}</p>
              ) : content?.status === "read" ? (
                <AssetContent
                  path="SKILL.md"
                  content={content.content}
                  presentation="document"
                  truncated={content.truncated}
                />
              ) : content ? (
                <p role="alert">
                  {t(
                    content.status === "denied"
                      ? "canvas.fileDenied"
                      : content.status === "too-large"
                        ? "canvas.tooLarge"
                        : content.status === "binary"
                          ? "canvas.binary"
                          : "canvas.fileUnavailable",
                  )}
                </p>
              ) : (
                <p role="status">{t("canvas.loading")}</p>
              )}
            </SheetFrame>,
            layer,
          )
        : null}
    </>
  );
}
