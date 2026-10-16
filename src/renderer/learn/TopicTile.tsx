import type { ReactElement } from "react";

import type { AcademyLessonSummary } from "../../shared/academy-ipc";
import { Icon } from "../components/Icon";
import { Illustration } from "./Illustration";

type TopicTileProps = Readonly<{ lesson: AcademyLessonSummary; onOpen: () => void }>;

export function TopicTile({ lesson, onOpen }: TopicTileProps): ReactElement {
  return (
    <button className="academy-topic-tile" onClick={onOpen} type="button">
      <Illustration pictogram={lesson.illustration} />
      <strong>{lesson.title}</strong>
      <span aria-hidden="true" className="academy-topic-tile__arrow">
        <Icon name="chevron-down" size={14} />
      </span>
    </button>
  );
}
