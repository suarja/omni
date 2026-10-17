import { LoadingSkeleton } from "../../components/ui/Skeleton";
import { useEffect, useState, type ReactElement } from "react";
import type { DesktopApi } from "../../../shared/ipc";
import type { NewStorefront } from "../../../shared/publication-operations-ipc";
import { newStorefrontSchema } from "../../../shared/publication-operations-ipc";
import { githubRepository } from "../../../domain/storefront-origin";
import { parseStorefrontCapabilities, type StorefrontCapabilities } from "../../../shared/storefront-presentation-ipc";
import { useI18n } from "../../i18n";

export function NewStorefrontFields(
  props: Readonly<{
    api: Partial<DesktopApi> | null;
    busy: boolean;
    purpose: "publish" | "create";
    onChange: (
      value: NewStorefront | null,
      repository: string,
      draft: Readonly<{ name: string; license: "MIT" | "Apache-2.0"; repositoryMode: "create" | "existing" }>,
    ) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [url, setUrl] = useState("");
  const [license, setLicense] = useState<"MIT" | "Apache-2.0">("MIT");
  const [capabilities, setCapabilities] = useState<StorefrontCapabilities | null>(null),
    [error, setError] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    setCapabilities(null);
    if (!props.api?.readStorefrontCapabilities) {
      setError(true);
      return;
    }
    void props.api
      .readStorefrontCapabilities()
      .then((raw) => {
        if (active) setCapabilities(parseStorefrontCapabilities(raw));
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [props.api, revision]);
  const repository =
    capabilities?.gh === "ready"
      ? `${capabilities.login}/${name || t("storefronts.name").toLocaleLowerCase()}`
      : (githubRepository(url) ?? "");
  useEffect(() => {
    const input = {
      name,
      description,
      license,
      ...(capabilities?.gh === "ready"
        ? { login: capabilities.login }
        : { repositoryUrl: url, login: githubRepository(url)?.split("/")[0] }),
    };
    const parsed = newStorefrontSchema.safeParse(input);
    props.onChange(
      capabilities && parsed.success && description.trim() && (capabilities.gh === "ready" || githubRepository(url))
        ? parsed.data
        : null,
      repository,
      { name, license, repositoryMode: capabilities?.gh === "ready" ? "create" : "existing" },
    );
  }, [name, description, license, url, capabilities, props.onChange, repository]);
  return (
    <div className="storefront-new-fields" data-github-state={capabilities?.gh ?? (error ? "error" : "loading")}>
      <label>
        {props.purpose === "create" ? <span className="storefront-label">{t("storefronts.name")}</span> : null}
        <input
          className="skill-input"
          aria-label={t("storefronts.name")}
          placeholder={t("storefronts.namePlaceholder")}
          value={name}
          maxLength={128}
          disabled={props.busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {props.purpose === "create" ? <span className="skill-hint">{t("storefronts.themeHint")}</span> : null}
      <label>
        {props.purpose === "create" ? <span className="storefront-label">{t("storefronts.sentence")}</span> : null}
        <input
          className="skill-input"
          aria-label={t("storefronts.sentence")}
          placeholder={t("storefronts.sentencePlaceholder")}
          value={description}
          maxLength={240}
          disabled={props.busy}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <div role="group" aria-label={t("storefronts.license")} className="new-skill-segment">
        {(["MIT", "Apache-2.0"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={license === value}
            disabled={props.busy}
            onClick={() => setLicense(value)}
          >
            {value}
          </button>
        ))}
      </div>
      {capabilities && capabilities.gh !== "ready" ? (
        <>
          <p className="sh-sub">{t("storefronts.noGh")}</p>
          <label>
            <span className="storefront-label">{t("storefronts.existingUrl")}</span>
            <input
              className="skill-input"
              aria-label={t("storefronts.existingUrl")}
              placeholder={t("storefronts.repositoryPlaceholder")}
              value={url}
              disabled={props.busy}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
        </>
      ) : error ? (
        <p role="alert">
          {t("storefronts.capabilityError")}{" "}
          <button
            type="button"
            className="canvas-secondary-button is-small"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t("storefronts.retry")}
          </button>
        </p>
      ) : !capabilities ? (
        <LoadingSkeleton label={t("storefronts.readingGithub")} variant="inline" />
      ) : null}
      {repository && props.purpose === "publish" ? (
        <span className="skill-hint">
          {t(capabilities?.gh === "ready" ? "storefronts.createHint" : "storefronts.existingRepoHint", {
            repository: "{repository}",
          })
            .split("{repository}")
            .map((part, index) =>
              index ? (
                <span key={index}>
                  <b>{repository}</b>
                  {part}
                </span>
              ) : (
                part
              ),
            )}
        </span>
      ) : null}
    </div>
  );
}
