import { opendir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

const MAX_ACTIVE = 2;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
let active = 0;

function errorResponse(id, code) {
  return { id, ok: false, error: { code } };
}

function validRequest(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 64 &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    !value.path.includes("\0") &&
    isAbsolute(value.path)
  );
}

function validName(name) {
  return typeof name === "string" && name.length > 0 && name !== "." && name !== ".." && !name.includes("/");
}

function addEntry(entries, entry, responseSize) {
  if (entries.length >= MAX_DIRECTORY_ENTRIES) throw Object.assign(new Error(), { code: "directory-entry-limit" });
  const item = {
    name: entry.name,
    isFile: entry.isFile(),
    isDirectory: entry.isDirectory(),
    isSymbolicLink: entry.isSymbolicLink(),
  };
  if (!validName(item.name)) throw Object.assign(new Error(), { code: "directory-invalid-entry" });
  const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (entries.length ? 1 : 0);
  if (responseSize.bytes + itemBytes > MAX_RESPONSE_BYTES)
    throw Object.assign(new Error(), { code: "directory-response-limit" });
  responseSize.bytes += itemBytes;
  entries.push(item);
}

function writeResponse(response) {
  const line = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_RESPONSE_BYTES) {
    const fallback = errorResponse(response.id, "directory-response-limit");
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
    return;
  }
  process.stdout.write(line);
}

async function listDirectory(id, path) {
  let directory;
  try {
    directory = await opendir(path);
    const entries = [];
    const responseSize = { bytes: Buffer.byteLength(`{"id":${JSON.stringify(id)},"ok":true,"entries":[]}\n`, "utf8") - 2 };
    for await (const entry of directory) addEntry(entries, entry, responseSize);
    writeResponse({ id, ok: true, entries });
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "directory-reader-error";
    writeResponse(errorResponse(id, code));
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
    writeResponse(errorResponse("invalid", "directory-invalid-request"));
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeResponse(errorResponse("invalid", "directory-invalid-request"));
    return;
  }
  if (!validRequest(request)) {
    writeResponse(errorResponse(typeof request?.id === "string" ? request.id : "invalid", "directory-invalid-request"));
    return;
  }
  if (active >= MAX_ACTIVE) {
    writeResponse(errorResponse(request.id, "directory-reader-busy"));
    return;
  }
  active += 1;
  void listDirectory(request.id, request.path).finally(() => {
    active -= 1;
  });
});
