import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  academyScreenshotName,
  parseAcademyFirstLaunchResponse,
  parseAcademyScreenshotResponse,
  parseAcademySnapshot,
  type AcademySnapshot,
} from "../../shared/academy-ipc";
import { resolveResource, type ResourceOptions } from "../omni-resources";

const SNAPSHOT_RELATIVE_PATH = "packages/omni-academy/academy.json";
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 1_500_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function loadAcademySnapshot(options: ResourceOptions = {}): Promise<AcademySnapshot> {
  const path = resolveResource(SNAPSHOT_RELATIVE_PATH, options);
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_SNAPSHOT_BYTES) throw new Error("Academy snapshot exceeds the size limit.");
  return parseAcademySnapshot(JSON.parse(raw) as unknown);
}

export async function loadAcademyScreenshot(
  name: string,
  options: ResourceOptions = {},
): Promise<{ dataUrl: string } | { status: "missing" }> {
  const safeName = academyScreenshotName(name);
  const path = resolveResource(`resources/academy/${safeName}.png`, options);
  let file: Buffer;
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_SCREENSHOT_BYTES) throw new Error("Academy screenshot exceeds the size limit.");
    file = await readFile(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw error;
  }
  if (file.byteLength > MAX_SCREENSHOT_BYTES) throw new Error("Academy screenshot exceeds the size limit.");
  if (!file.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    throw new Error("Academy screenshot is not a PNG.");
  return parseAcademyScreenshotResponse({ dataUrl: `data:image/png;base64,${file.toString("base64")}` });
}

export async function readFirstLaunch(
  userDataPath: string,
  now: () => string = () => new Date().toISOString(),
): Promise<{ installedAt: string }> {
  const directory = join(userDataPath, "omni");
  const path = join(directory, "first-launch.json");
  try {
    const existing = parseAcademyFirstLaunchResponse(JSON.parse(await readFile(path, "utf8")) as unknown);
    return existing;
  } catch {
    const created = { installedAt: now() };
    parseAcademyFirstLaunchResponse(created);
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify(created) + "\n", { encoding: "utf8", flag: "wx" }).catch(
      async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      },
    );
    try {
      return parseAcademyFirstLaunchResponse(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch {
      return created;
    }
  }
}

export function academySummary(snapshot: AcademySnapshot, lang: "en" | "fr") {
  return snapshot.lessons.filter((lesson) => lesson.lang === lang).map(({ body: _body, ...summary }) => summary);
}
