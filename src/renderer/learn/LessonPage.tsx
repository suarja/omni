import { LoadingSkeleton, Skeleton } from "../components/ui/Skeleton";
import { useEffect, useRef, useState, type ReactElement } from "react";

import type { DesktopApi } from "../../shared/ipc";
import type {
  AcademyIllustration,
  AcademyKind,
  AcademyLanguage,
  AcademyLesson,
  AcademyLessonResponse,
  AcademyProduct,
} from "../../shared/academy-ipc";
import { splitLessonBody } from "../../shared/academy-ipc";
import { Button } from "../components/ui/Button";
import { useI18n } from "../i18n";
import type { Route } from "../navigation";
import { Markdown } from "../components/Markdown";
import { Illustration } from "./Illustration";

export type LessonPageProps = Readonly<{
  api?: DesktopApi | null;
  lesson?: AcademyLesson;
  lang?: AcademyLanguage;
  kind?: AcademyKind;
  slug?: string;
  onNavigateToRoute: (route: Route) => void;
}>;

function sectionLabel(kind: AcademyKind, language: AcademyLanguage): string {
  if (kind === "course") return language === "fr" ? "Cours" : "Courses";
  if (kind === "tutorial") return language === "fr" ? "Tutoriels" : "Tutorials";
  return language === "fr" ? "Thèmes" : "Topics";
}

export function academyCtaRoute(route: NonNullable<AcademyLesson["cta"]>["route"]): Route {
  if (route === "library") return { screen: "library", tab: "marketplaces" };
  if (route === "library-add") return { screen: "library-add" };
  if (route === "projects") return { screen: "projects" };
  if (route === "review") return { screen: "review" };
  return { screen: "settings" };
}

function productLabel(product: AcademyProduct): string {
  return product === "claude-code" ? "Claude Code" : "Codex";
}

function responseLesson(response: AcademyLessonResponse): AcademyLesson | null {
  return response.status === "ready" ? response.lesson : null;
}

function academyTarget(target: string, lang: AcademyLanguage): Route | null {
  const match = /^academy:\/\/(course|tutorial|topic)\/([a-z0-9-]+)$/u.exec(target);
  if (!match) return null;
  return { screen: "academy-lesson", lang, kind: match[1] as AcademyKind, slug: match[2] };
}

function AcademyScreenshot({
  api,
  fallback,
  name,
  hero = false,
}: Readonly<{ api?: DesktopApi | null; fallback: AcademyIllustration; name: string; hero?: boolean }>): ReactElement {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!api?.getAcademyScreenshot) return () => undefined;
    void api
      .getAcademyScreenshot({ name })
      .then((response) => {
        if (active && "dataUrl" in response) setDataUrl(response.dataUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, name]);
  if (!dataUrl)
    return <Illustration className={hero ? undefined : "academy-illustration--figure"} pictogram={fallback} />;
  return (
    <img
      alt=""
      className={hero ? "academy-screenshot academy-screenshot--hero" : "academy-screenshot"}
      data-testid={`academy-screenshot-${name}`}
      src={dataUrl}
    />
  );
}

export function LessonPage({
  api = null,
  kind,
  lang,
  lesson: suppliedLesson,
  onNavigateToRoute,
  slug,
}: LessonPageProps): ReactElement {
  const { language, t } = useI18n();
  const [lesson, setLesson] = useState<AcademyLesson | null>(suppliedLesson ?? null);
  const [loading, setLoading] = useState(suppliedLesson === undefined);
  const bodyRef = useRef<HTMLElement>(null);
  const [steps, setSteps] = useState<readonly string[]>([]);
  const [activeStep, setActiveStep] = useState(0);
  const resolvedLanguage = lang ?? language;
  const resolvedKind = kind ?? suppliedLesson?.kind ?? "topic";

  useEffect(() => {
    if (suppliedLesson) {
      setLesson(suppliedLesson);
      setLoading(false);
      return;
    }
    if (!api?.getAcademyLesson || !kind || !slug) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void api
      .getAcademyLesson({ lang: resolvedLanguage, kind, slug })
      .then((response) => {
        if (active) setLesson(responseLesson(response));
      })
      .catch(() => {
        if (active) setLesson(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, kind, resolvedLanguage, slug, suppliedLesson]);

  useEffect(() => {
    if (!lesson || (resolvedKind !== "tutorial" && resolvedKind !== "course") || !bodyRef.current) {
      setSteps([]);
      return;
    }
    const headings = [...bodyRef.current.querySelectorAll<HTMLHeadingElement>("h2")];
    headings.forEach((heading, index) => {
      heading.id = `academy-step-${index}`;
    });
    setSteps(headings.map((heading) => heading.textContent ?? ""));
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) {
          const index = headings.indexOf(visible.target as HTMLHeadingElement);
          if (index >= 0) setActiveStep(index);
        }
      },
      { rootMargin: "-18% 0px -68% 0px", threshold: 0 },
    );
    headings.forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, [lesson, resolvedKind]);

  if (loading && !lesson)
    return (
      <div className="academy-lesson-page">
        <div className="academy-breadcrumb">{t("learn.heading")}</div>
        <LoadingSkeleton
          label={t("learn.loading")}
          variant="document"
          rows={6}
          shapes={
            <>
              <header className="academy-lesson-head">
                <Skeleton shape="line" width="65%" height="var(--font-size-title)" />
              </header>
              <div className="academy-lesson-body">
                <Skeleton height={360} />
              </div>
            </>
          }
        />
      </div>
    );
  if (!lesson) return <p className="academy-loading">{t("learn.lessonNotFound")}</p>;
  const heroShot = splitLessonBody(lesson.body).find((block) => block.kind === "screenshot")?.name;
  return (
    <div className="academy-lesson-page" data-testid="lesson-page">
      <div className="academy-breadcrumb">
        <button onClick={() => onNavigateToRoute({ screen: "learn" })} type="button">
          {t("learn.heading")}
        </button>
        <span aria-hidden="true">/</span>
        <span>{sectionLabel(lesson.kind, lesson.lang)}</span>
        <span aria-hidden="true">/</span>
        <span>{lesson.title}</span>
      </div>
      <header className="academy-lesson-head">
        <div>
          <span className="academy-card-label">{sectionLabel(lesson.kind, lesson.lang)}</span>
          <h1>{lesson.title}</h1>
          <p>{lesson.summary}</p>
          <div className="academy-lesson-meta">
            {lesson.minutes ? (
              <span className="academy-pill">
                {lesson.minutes} {t("learn.minutes")}
              </span>
            ) : null}
            {lesson.products.map((product) => (
              <span className="academy-pill" key={product}>
                {productLabel(product)}
              </span>
            ))}
          </div>
          {lesson.cta ? (
            <Button dataTestId="lesson-cta" onClick={() => onNavigateToRoute(academyCtaRoute(lesson.cta!.route))}>
              {lesson.cta.label}
            </Button>
          ) : null}
        </div>
        {/* The reference hero shows the product itself: the lesson's first screenshot when one exists. */}
        {heroShot ? (
          <AcademyScreenshot api={api} fallback={lesson.illustration} hero name={heroShot} />
        ) : (
          <Illustration pictogram={lesson.illustration} />
        )}
      </header>
      <div
        className={`academy-lesson-layout${lesson.kind === "tutorial" || lesson.kind === "course" ? " academy-lesson-layout--tutorial" : ""}`}
      >
        <article
          className="academy-lesson-body"
          onClick={(event) => {
            const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>(".markdown__link");
            const target = anchor?.getAttribute("title");
            const route = target ? academyTarget(target, lesson.lang) : null;
            if (route) onNavigateToRoute(route);
          }}
          ref={bodyRef}
        >
          {splitLessonBody(lesson.body).map((block, index) =>
            block.kind === "markdown" ? (
              <Markdown key={index} source={block.source} />
            ) : block.kind === "illustration" ? (
              <Illustration className="academy-illustration--figure" key={index} pictogram={block.id} />
            ) : (
              <AcademyScreenshot api={api} fallback={lesson.illustration} key={index} name={block.name} />
            ),
          )}
        </article>
        {lesson.kind === "tutorial" || lesson.kind === "course" ? (
          <aside className="academy-toc" data-testid="lesson-toc">
            <strong>{t("learn.onThisPage")}</strong>
            <nav aria-label={t("learn.onThisPage")}>
              {steps.map((step, index) => (
                <a className={index === activeStep ? "is-active" : ""} href={`#academy-step-${index}`} key={step}>
                  {step}
                </a>
              ))}
            </nav>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
