import { AcademyLoadingShapes } from "./AcademyLoadingShapes";
import { LoadingBoundary } from "../components/ui/Skeleton";
import { useEffect, useState, type ReactElement } from "react";

import type { DesktopApi } from "../../shared/ipc";
import type { AcademyLanguage, AcademyLessonSummary } from "../../shared/academy-ipc";
import { PageHead } from "../components/ui/PageHead";
import { SectionHeading } from "../components/ui/SectionHeading";
import { useI18n } from "../i18n";
import type { Route } from "../navigation";
import { CourseCard } from "./CourseCard";
import { TopicTile } from "./TopicTile";
import { TutorialCard } from "./TutorialCard";
import "./learn.css";

export type LearnViewProps = Readonly<{
  api?: DesktopApi | null;
  lessons?: readonly AcademyLessonSummary[];
  onNavigateToRoute: (route: Route) => void;
}>;

function openLesson(
  lesson: AcademyLessonSummary,
  language: AcademyLanguage,
  onNavigateToRoute: (route: Route) => void,
): void {
  onNavigateToRoute({ screen: "academy-lesson", lang: language, kind: lesson.kind, slug: lesson.slug });
}

export function LearnView({ api = null, lessons: suppliedLessons, onNavigateToRoute }: LearnViewProps): ReactElement {
  const { language, t } = useI18n();
  const [lessons, setLessons] = useState<readonly AcademyLessonSummary[]>(suppliedLessons ?? []);
  const [loading, setLoading] = useState(suppliedLessons === undefined);

  useEffect(() => {
    if (suppliedLessons !== undefined) {
      setLessons(suppliedLessons);
      setLoading(false);
      return;
    }
    if (!api?.listAcademyLessons) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void api
      .listAcademyLessons({ lang: language })
      .then((response) => {
        if (active) setLessons(response.lessons);
      })
      .catch(() => {
        if (active) setLessons([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, language, suppliedLessons]);

  const courses = lessons.filter((lesson) => lesson.kind === "course");
  const tutorials = lessons.filter((lesson) => lesson.kind === "tutorial");
  const topics = lessons.filter((lesson) => lesson.kind === "topic");
  return (
    <div className="shell-page destination-page academy-page" data-testid="learn-page">
      <PageHead description={t("learn.description")} title={t("learn.heading")} />

      <section data-testid="learn-courses">
        <SectionHeading hint={t("learn.coursesDescription")} title={t("learn.courses")} />
        <LoadingBoundary
          loading={loading && !lessons.length}
          label={t("canvas.loadingSurface", { surface: t("learn.courses") })}
          shapes={<AcademyLoadingShapes kind="courses" />}
          minHeight={460}
        >
          <div className="academy-course-list">
            {courses.map((lesson) => (
              <CourseCard
                key={lesson.slug}
                lesson={lesson}
                onOpen={() => openLesson(lesson, language, onNavigateToRoute)}
              />
            ))}
          </div>
        </LoadingBoundary>
      </section>
      <section data-testid="learn-tutorials">
        <SectionHeading hint={t("learn.tutorialsDescription")} title={t("learn.tutorials")} />
        <LoadingBoundary
          loading={loading && !lessons.length}
          label={t("canvas.loadingSurface", { surface: t("learn.tutorials") })}
          shapes={<AcademyLoadingShapes kind="tutorials" />}
          minHeight={220}
        >
          <div className="academy-tutorial-grid">
            {tutorials.map((lesson) => (
              <TutorialCard
                key={lesson.slug}
                lesson={lesson}
                onOpen={() => openLesson(lesson, language, onNavigateToRoute)}
              />
            ))}
          </div>
        </LoadingBoundary>
      </section>
      <section data-testid="learn-topics">
        <SectionHeading hint={t("learn.topicsDescription")} title={t("learn.topics")} />
        <LoadingBoundary
          loading={loading && !lessons.length}
          label={t("canvas.loadingSurface", { surface: t("learn.topics") })}
          shapes={<AcademyLoadingShapes kind="topics" />}
          minHeight={70}
        >
          <div className="academy-topic-grid">
            {topics.map((lesson) => (
              <TopicTile
                key={lesson.slug}
                lesson={lesson}
                onOpen={() => openLesson(lesson, language, onNavigateToRoute)}
              />
            ))}
          </div>
        </LoadingBoundary>
      </section>
    </div>
  );
}
