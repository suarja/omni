import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = resolve(root, "plugins/omni/runtime/omni-mcp.mjs");
const target = resolve(root, "out/plugins/omni/runtime/omni-mcp.mjs");

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`Staged ${target}`);
