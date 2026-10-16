import type { ReactElement } from "react";

import { Markdown } from "../components/Markdown";

type AssetContentProps = Readonly<{
  content: string;
  path: string;
  truncated: boolean;
  presentation?: "embedded" | "document";
}>;

type Frontmatter = Readonly<{ fields: readonly (readonly [string, string])[]; body: string }>;

const HIDDEN_FIELDS = new Set(["name", "description"]);

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

function splitFrontmatter(content: string): Frontmatter {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { fields: [], body: content };
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closing < 0) return { fields: [], body: content };
  const fields: (readonly [string, string])[] = [];
  for (const line of lines.slice(1, closing + 1)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (field && !HIDDEN_FIELDS.has(field[1]) && field[2].trim() && !/^[>|][+-]?$/.test(field[2].trim()))
      fields.push([field[1], field[2].trim()]);
  }
  return { fields, body: lines.slice(closing + 2).join("\n") };
}

function isCodeLine(line: string): boolean {
  return /^(?:---|#|\{|\})/.test(line);
}

export function AssetContent({ content, path, truncated, presentation = "embedded" }: AssetContentProps): ReactElement {
  const label = truncated ? "Truncated content" : "Artifact content";
  if (!isMarkdownPath(path)) {
    return (
      <div aria-label={label} className="asset-content" data-testid="asset-content">
        {content.split("\n").map((line, index) => (
          <div
            className={`asset-content__line${isCodeLine(line) ? " is-faint" : ""}`}
            data-testid="asset-content-line"
            key={`${index}-${line}`}
          >
            {line}
          </div>
        ))}
      </div>
    );
  }
  const { fields, body } = splitFrontmatter(content);
  return (
    <div aria-label={label} className="asset-markdown" data-testid="asset-content">
      {fields.length ? (
        <dl className="asset-frontmatter" data-testid="asset-frontmatter">
          {fields.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <Markdown className="asset-markdown__body" presentation={presentation} source={body} />
    </div>
  );
}
