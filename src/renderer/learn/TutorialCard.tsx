import type { ReactElement } from "react";

import type { AcademyLessonSummary } from "../../shared/academy-ipc";
import { Illustration } from "./Illustration";
import { useI18n } from "../i18n";

type TutorialCardProps = Readonly<{ lesson: AcademyLessonSummary; onOpen: () => void }>;

export function TutorialCard({ lesson, onOpen }: TutorialCardProps): ReactElement {
  const { t } = useI18n();
  return (
    <button className="academy-tutorial-card" data-testid="lesson-card-tutorial" onClick={onOpen} type="button">
      <span className="academy-tutorial-card__art">
        <Illustration pictogram={lesson.illustration} />
        <span className="academy-duration">
          {lesson.minutes} {t("learn.minutes")}
        </span>
      </span>
      <span className="academy-card-label">{t("learn.tutorialLabel")}</span>
      <strong>{lesson.title}</strong>
    </button>
  );
}
