export type RecordValue = Record<string, unknown>;

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

export function assertKeys(value: RecordValue, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${label} has an unexpected field "${key}".`);
}

export function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

export function readOpaque(value: unknown, label: string): string {
  const text = readText(value, label);
  if (
    text.includes("/") ||
    text.includes("\\") ||
    text.includes("..") ||
    /[\u0000-\u001f\u007f-\u009f\r\n]/u.test(text)
  )
    throw new Error(`${label} must be opaque.`);
  return text;
}

export function readDisplay(value: unknown, label: string): string {
  const text = readText(value, label);
  if (
    text.includes("/") ||
    text.includes("\\") ||
    text.includes("..") ||
    /[\u0000-\u001f\u007f-\u009f\r\n]/u.test(text)
  )
    throw new Error(`${label} is not safe for IPC.`);
  return text;
}

export function readDisplayPath(value: unknown, label: string): string {
  const text = readText(value, label).replaceAll("\\", "/");
  if (
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    text.split("/").some((part) => !part || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f-\u009f\r\n]/u.test(text)
  )
    throw new Error(`${label} is not safe for IPC.`);
  return text;
}

export function readRelativePath(value: unknown): string {
  const path = readText(value, "Operation relative path").replaceAll("\\", "/");
  if (
    path !== "." &&
    (path.startsWith("/") ||
      /^[A-Za-z]:\//.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === ".."))
  )
    throw new Error("Operation path is unsafe.");
  return path;
}

export function readByteLength(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Operation byte length is invalid.");
  return value as number;
}

export function readHash(value: unknown, label: string): string {
  const hash = readText(value, label);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} is invalid.`);
  return hash;
}
