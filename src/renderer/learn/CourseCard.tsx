import type { ReactElement } from "react";

import type { AcademyLessonSummary } from "../../shared/academy-ipc";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";
import { Illustration } from "./Illustration";

type CourseCardProps = Readonly<{ lesson: AcademyLessonSummary; onOpen: () => void }>;

export function CourseCard({ lesson, onOpen }: CourseCardProps): ReactElement {
  const { t } = useI18n();
  return (
    <button className="academy-course-card" data-testid="lesson-card-course" onClick={onOpen} type="button">
      <Illustration className="academy-course-card__illustration" pictogram={lesson.illustration} />
      <span className="academy-course-card__copy">
        <span className="academy-card-label">{t("learn.courseLabel")}</span>
        <strong>{lesson.title}</strong>
        <span>{lesson.summary}</span>
      </span>
      <span aria-hidden="true" className="academy-card-arrow">
        <Icon name="chevron-down" size={17} />
      </span>
    </button>
  );
}
