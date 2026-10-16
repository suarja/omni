export type ExternalLockLine = Readonly<{
  source: string;
  sourceType: "github";
  skillPath: string;
  computedHash: string;
}>;
export function restoreExternalSkillsLock(
  current: string | undefined,
  before: string | undefined,
  after: string | undefined,
): string | undefined {
  if (current === after) return before;
  if (current === undefined || after === undefined) throw new Error("The external lock changed after the operation.");
  const original = before ?? '{"version":1,"skills":{}}';
  const readEntries = (text: string): Map<string, Member> => {
    JSON.parse(text);
    return new Map(skillMembers(text).entries.map((member) => [member.key, member]));
  };
  const beforeEntries = readEntries(original),
    afterEntries = readEntries(after),
    currentEntries = readEntries(current);
  const value = (text: string, member?: Member): string | undefined =>
    member ? canonical(JSON.parse(text.slice(member.start, member.end))) : undefined;
  const changed = [...new Set([...beforeEntries.keys(), ...afterEntries.keys()])].filter(
    (name) => value(original, beforeEntries.get(name)) !== value(after, afterEntries.get(name)),
  );
  let result = current;
  for (const name of changed) {
    if (value(current, currentEntries.get(name)) !== value(after, afterEntries.get(name)))
      throw new Error(`External lock entry ${name} changed after the operation. Retain it and inspect recovery.`);
    const parsed = skillMembers(result),
      index = parsed.entries.findIndex((entry) => entry.key === name);
    const member = parsed.entries[index],
      previous = beforeEntries.get(name);
    if (!member) throw new Error("The external lock entry is missing. Inspect recovery.");
    if (previous)
      result = result.slice(0, member.start) + original.slice(previous.start, previous.end) + result.slice(member.end);
    else {
      const start = index ? parsed.entries[index - 1]!.end : member.keyStart;
      const end = index ? member.end : (parsed.entries[index + 1]?.keyStart ?? member.end);
      result = result.slice(0, start) + result.slice(end);
    }
  }
  return result;
}
type Member = Readonly<{ key: string; keyStart: number; start: number; end: number }>;
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, sort(child)]),
          )
        : item;
  return JSON.stringify(sort(value));
}

function skipSpace(text: string, index: number): number {
  while (/\s/u.test(text[index] ?? "x")) index++;
  return index;
}
function skipString(text: string, index: number): number {
  index++;
  while (index < text.length) {
    if (text[index] === "\\") index += 2;
    else if (text[index++] === '"') return index;
  }
  throw new Error("Unterminated lock string.");
}
function skipValue(text: string, index: number): number {
  if (text[index] === '"') return skipString(text, index);
  if (text[index] === "{" || text[index] === "[") {
    const end = text[index] === "{" ? "}" : "]";
    index++;
    while (text[index] !== end && index < text.length) {
      index = skipSpace(text, index);
      if (text[index] === end) break;
      if (text[index] === "," || text[index] === ":") index++;
      else index = skipValue(text, index);
    }
    return index + 1;
  }
  while (index < text.length && !/[\s,}\]]/u.test(text[index]!)) index++;
  return index;
}
function members(text: string, start: number): Member[] {
  if (text[start] !== "{") throw new Error("Skills lock must contain an object.");
  let index = skipSpace(text, start + 1);
  const result: Member[] = [],
    seen = new Set<string>();
  while (text[index] !== "}") {
    const keyEnd = skipString(text, index);
    const key: string = JSON.parse(text.slice(index, keyEnd));
    if (seen.has(key)) throw new Error("Skills lock contains a duplicate key.");
    seen.add(key);
    const valueStart = skipSpace(text, skipSpace(text, keyEnd) + 1);
    const end = skipValue(text, valueStart);
    result.push({ key, keyStart: index, start: valueStart, end });
    index = skipSpace(text, end);
    if (text[index] === ",") index = skipSpace(text, index + 1);
  }
  return result;
}
function skillMembers(text: string): { start: number; entries: Member[] } {
  const skills = members(text, skipSpace(text, 0)).find((member) => member.key === "skills");
  if (!skills) throw new Error("Skills lock has no skills object. Repair it before installing.");
  return { start: skills.start, entries: members(text, skills.start) };
}

export function editExternalSkillsLock(
  text: string | undefined,
  entries: ReadonlyMap<string, ExternalLockLine>,
): string {
  if (text === undefined) return `${JSON.stringify({ version: 1, skills: Object.fromEntries(entries) }, null, 2)}\n`;
  if (text.length > 1024 * 1024) throw new Error("Skills lock exceeds the byte limit.");
  JSON.parse(text);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = text.match(/\r?\n([\t ]+)"/u)?.[1] ?? "";
  const format = (value: unknown): string =>
    JSON.stringify(value, null, indent || undefined).replaceAll("\n", newline + indent.repeat(2));
  let result = text;
  const existing = skillMembers(result).entries;
  for (const member of [...existing].reverse()) {
    const replacement = entries.get(member.key);
    if (!replacement) continue;
    const old: unknown = JSON.parse(result.slice(member.start, member.end));
    const fields = new Map(typeof old === "object" && old !== null && !Array.isArray(old) ? Object.entries(old) : []);
    for (const [key, value] of Object.entries(replacement)) fields.set(key, value);
    result = result.slice(0, member.start) + format(Object.fromEntries(fields)) + result.slice(member.end);
  }
  const fresh = skillMembers(result);
  const added = [...entries].filter(([key]) => !existing.some((member) => member.key === key));
  if (added.length) {
    const index = fresh.entries.at(-1)?.end ?? fresh.start + 1;
    const prefix = indent ? newline + indent.repeat(2) : "";
    const insertion =
      (fresh.entries.length ? "," : "") +
      added.map(([key, value]) => prefix + JSON.stringify(key) + (indent ? ": " : ":") + format(value)).join(",");
    const emptySuffix = !fresh.entries.length && indent && !/\s/u.test(result[index] ?? "") ? newline + indent : "";
    result = result.slice(0, index) + insertion + emptySuffix + result.slice(index);
  }
  return result;
}
