import type { ReactElement } from "react";
import { Skeleton } from "../components/ui/Skeleton";

/** Reuse the reading cards' grid, padding and breakpoints while their summaries load. */
export function AcademyLoadingShapes({ kind }: Readonly<{ kind: "courses" | "tutorials" | "topics" }>): ReactElement {
  const course = kind === "courses";
  const topic = kind === "topics";
  const className = course ? "academy-course-list" : topic ? "academy-topic-grid" : "academy-tutorial-grid";
  const cardClass = course ? "academy-course-card" : topic ? "academy-topic-tile" : "academy-tutorial-card";
  return (
    <div className={className}>
      {Array.from({ length: topic ? 4 : 3 }, (_, index) => (
        <div className={cardClass} key={index}>
          <Skeleton width={course ? 188 : topic ? 42 : "100%"} height={course ? 106 : topic ? 42 : 126} radius={9} />
          <div className="ui-skeleton-copy" style={{ width: "100%" }}>
            <Skeleton shape="line" width="68%" />
            {!topic ? <Skeleton shape="line" width="92%" /> : null}
          </div>
          {course ? <Skeleton shape="circle" width={38} height={38} /> : null}
        </div>
      ))}
    </div>
  );
}
