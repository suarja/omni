import type { ReactElement, ReactNode } from "react";

type MarkdownProps = Readonly<{ source: string; className?: string; presentation?: "embedded" | "document" }>;

function inlineNodes(source: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const token =
    /(!\[([^\]]*)\]\(([^)]+)\))|(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*|__([^_]+)__)|(\*([^*]+)\*|_([^_]+)_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(source)) !== null) {
    if (match.index > cursor) nodes.push(source.slice(cursor, match.index));
    const key = `${keyPrefix}-${nodes.length}`;
    if (match[1]) nodes.push(match[2]);
    else if (match[4])
      nodes.push(
        <a key={key} className="markdown__link" onClick={(event) => event.preventDefault()} title={match[6]}>
          {inlineNodes(match[5] ?? "", key)}
        </a>,
      );
    else if (match[7]) nodes.push(<code key={key}>{match[8]}</code>);
    else if (match[9]) nodes.push(<strong key={key}>{inlineNodes(match[10] ?? match[11] ?? "", key)}</strong>);
    else nodes.push(<em key={key}>{inlineNodes(match[13] ?? match[14] ?? "", key)}</em>);
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) nodes.push(source.slice(cursor));
  return nodes;
}

function rowCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isUnordered(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line);
}

function isOrdered(line: string): boolean {
  return /^\s*\d+[.)]\s+/.test(line);
}

function isBlockStart(line: string, nextLine?: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^\s*#{1,3}\s+/.test(line) ||
    /^\s*>/.test(line) ||
    isUnordered(line) ||
    isOrdered(line) ||
    (nextLine !== undefined && line.includes("|") && isTableDivider(nextLine))
  );
}

function blockNodes(source: string, presentation: "embedded" | "document"): ReactNode[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const nodes: ReactNode[] = [];
  const add = (node: ReactNode): void => {
    nodes.push(node);
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = /^\s*```/.test(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index] ?? "")) code.push(lines[index++] ?? "");
      if (index < lines.length) index += 1;
      add(
        <pre key={`block-${nodes.length}`}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (heading) {
      if (heading[1].length > 1 || presentation === "document") {
        const Tag = heading[1].length === 1 ? "h1" : heading[1].length === 2 ? "h2" : "h3";
        add(<Tag key={`block-${nodes.length}`}>{inlineNodes(heading[2], `heading-${nodes.length}`)}</Tag>);
      }
      index += 1;
      continue;
    }
    if (line.includes("|") && isTableDivider(lines[index + 1])) {
      const header = rowCells(line);
      index += 2;
      const body: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|")) body.push(rowCells(lines[index++] ?? ""));
      add(
        <table key={`block-${nodes.length}`}>
          <thead>
            <tr>
              {header.map((cell, cellIndex) => (
                <th key={`head-${cellIndex}`}>{inlineNodes(cell, `table-head-${cellIndex}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`cell-${rowIndex}-${cellIndex}`}>{inlineNodes(cell, `table-${rowIndex}-${cellIndex}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? ""))
        quote.push((lines[index++] ?? "").replace(/^\s*>\s?/, ""));
      add(
        <blockquote key={`block-${nodes.length}`}>{inlineNodes(quote.join(" "), `quote-${nodes.length}`)}</blockquote>,
      );
      continue;
    }
    if (isUnordered(line) || isOrdered(line)) {
      const ordered = isOrdered(line);
      const items: string[] = [];
      while (index < lines.length && (ordered ? isOrdered(lines[index] ?? "") : isUnordered(lines[index] ?? ""))) {
        items.push((lines[index++] ?? "").replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, ""));
      }
      const Tag = ordered ? "ol" : "ul";
      add(
        <Tag key={`block-${nodes.length}`}>
          {items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`}>{inlineNodes(item, `list-${itemIndex}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() && !isBlockStart(lines[index] ?? "", lines[index + 1]))
      paragraph.push((lines[index++] ?? "").trim());
    add(<p key={`block-${nodes.length}`}>{inlineNodes(paragraph.join(" "), `paragraph-${nodes.length}`)}</p>);
  }
  return nodes;
}

export function Markdown({ className = "", source, presentation = "embedded" }: MarkdownProps): ReactElement {
  return <div className={`markdown ${className}`.trim()}>{blockNodes(source, presentation)}</div>;
}
