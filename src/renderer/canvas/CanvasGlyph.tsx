import type { ReactElement } from "react";

export type CanvasGlyphName =
  | "storefront"
  | "marketplace"
  | "external"
  | "project"
  | "skill"
  | "doc"
  | "group"
  | "warn"
  | "home"
  | "review"
  | "activity"
  | "settings";

const glyphs: Record<CanvasGlyphName, ReactElement> = {
  storefront: <path d="M4 10h16M5 10l1-5h12l1 5M6 10v9h12v-9M10 19v-5h4v5" />,
  marketplace: (
    <>
      <path d="M4 9h16l-1.5-4h-13zM5 9v10h14V9M9 13h6" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6M20 4l-8 8M18 14v5H5V6h5" />
    </>
  ),
  project: (
    <>
      <path d="M3 7h7l2 2h9v10H3z" />
    </>
  ),
  skill: (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4M10 12h5M10 16h5" />
    </>
  ),
  doc: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M9 11h7M9 15h7M9 7h3" />
    </>
  ),
  group: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  warn: (
    <>
      <path d="M12 4 2.5 20h19z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
  home: (
    <>
      <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" />
    </>
  ),
  review: (
    <>
      <path d="M4 13h4l2 3h4l2-3h4" />
      <path d="M5 13 7 5h10l2 8v6H5z" />
    </>
  ),
  activity: (
    <>
      <path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.7" />
      <path d="M4 4v4.7h4.7M12 8v4l3 2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" />
    </>
  ),
};

export function CanvasGlyph(props: Readonly<{ name: CanvasGlyphName; size?: number }>): ReactElement {
  return (
    <svg
      aria-hidden="true"
      data-glyph={props.name}
      width={props.size ?? 18}
      height={props.size ?? 18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
    >
      {glyphs[props.name]}
    </svg>
  );
}
