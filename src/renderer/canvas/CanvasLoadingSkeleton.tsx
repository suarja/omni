import type { ReactElement } from "react";
import { LoadingSkeleton } from "../components/ui/Skeleton";
import "./canvas-loading.css";

/** Mirrors the workspace's source column on the left and project column on the right. */
export function CanvasLoadingSkeleton({ label }: Readonly<{ label: string }>): ReactElement {
  return (
    <div className="canvas-loading-nodes">
      {[-290, 290].flatMap((x) =>
        [-64, 64].map((y) => (
          <div className="canvas-loading-node" key={`${x}:${y}`} style={{ left: x - 132, top: y - 36 }}>
            <LoadingSkeleton label={label} variant="cards" rows={1} />
          </div>
        )),
      )}
    </div>
  );
}
