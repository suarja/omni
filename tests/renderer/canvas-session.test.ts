import { describe, expect, it } from "vitest";

import { createCanvasSession } from "../../src/renderer/canvas/spatial/canvas-session";

describe("renderer canvas session", () => {
  it("isolates camera state by qualified context and group key", () => {
    const session = createCanvasSession();
    session.write("entry:project:one", { groupId: null, cameras: { overview: { x: 1, y: 2, scale: 1 } } });
    session.write("entry:source:one", { groupId: null, cameras: { overview: { x: 3, y: 4, scale: 1 } } });
    session.write("entry:project:one:group:individual-skills", {
      groupId: "individual-skills",
      cameras: { group: { x: 5, y: 6, scale: 0.8 } },
    });

    expect(session.read("entry:project:one")?.cameras.overview?.x).toBe(1);
    expect(session.read("entry:source:one")?.cameras.overview?.x).toBe(3);
    expect(session.read("entry:project:one:group:individual-skills")?.cameras.group?.x).toBe(5);
  });

  it("copies values on read and write and keeps separate shell instances", () => {
    const first = createCanvasSession();
    const second = createCanvasSession();
    const mutable = { groupId: "individual-skills" as string | null, cameras: { group: { x: 5, y: 6, scale: 0.8 } } };
    first.write("project", mutable);
    mutable.cameras.group.x = 99;
    const read = first.read("project") as typeof mutable;
    read.cameras.group.y = 99;

    expect(first.read("project")?.cameras.group).toEqual({ x: 5, y: 6, scale: 0.8 });
    expect(second.read("project")).toBeUndefined();
  });
});
