import type { ReactElement } from "react";

export type IconName =
  | "agent"
  | "activity"
  | "chevron-down"
  | "command"
  | "folder"
  | "grid"
  | "git"
  | "home"
  | "info"
  | "question"
  | "warning"
  | "hook"
  | "instruction"
  | "library"
  | "marketplace"
  | "mcp"
  | "more"
  | "plugin"
  | "remote"
  | "package"
  | "plus"
  | "refresh"
  | "restore"
  | "search"
  | "settings"
  | "spark"
  | "target"
  | "review"
  | "x";

type IconProps = Readonly<{
  name: IconName;
  size?: number;
}>;

const paths: Record<IconName, ReactElement> = {
  agent: (
    <>
      <circle cx="12" cy="8" r="3" />
      <path d="M5 20a7 7 0 0 1 14 0M4 12h3M17 12h3" />
    </>
  ),
  activity: <path d="M3 12h4l2.2-6 5.6 12 2.2-6H21" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  command: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="2" />
      <rect x="14" y="4" width="6" height="6" rx="2" />
      <rect x="4" y="14" width="6" height="6" rx="2" />
      <path d="M14 17h3a3 3 0 0 0 3-3v-1" />
    </>
  ),
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  grid: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1.5" />
      <rect x="14" y="4" width="6" height="6" rx="1.5" />
      <rect x="4" y="14" width="6" height="6" rx="1.5" />
      <rect x="14" y="14" width="6" height="6" rx="1.5" />
    </>
  ),
  git: (
    <>
      <path d="m8 5 8 8M8 19l8-8" />
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="11" r="2" />
      <circle cx="6" cy="19" r="2" />
    </>
  ),
  home: <path d="m4 10 8-6 8 6v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM9 20v-6h6v6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.7 9a2.4 2.4 0 1 1 4.4 1.3c-.8 1.1-2.1 1.3-2.1 3M12 17h.01" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3.5 21 20H3z" />
      <path d="M12 9v4M12 16.5h.01" />
    </>
  ),
  hook: <path d="M7 7a4 4 0 1 1 4 4H8a4 4 0 1 0 4 4v-2" />,
  instruction: (
    <>
      <path d="M6 4h9l3 3v13H6z" />
      <path d="M15 4v4h4M9 12h6M9 16h6" />
    </>
  ),
  library: (
    <>
      <path d="M3 3.2h2.6v9.6H3zM6.9 3.2h2.6v9.6H6.9zM11.2 3.9l2.2 8.6" />
    </>
  ),
  marketplace: (
    <>
      <path d="M4 10h16l-1.5-4h-13zM5 10v9h14v-9M9 19v-5h6v5" />
      <path d="M4 10h16" />
    </>
  ),
  mcp: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 5v14M5 12h14M9 9l6 6M15 9l-6 6" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  plugin: <path d="M9 4v3H7a3 3 0 0 0 0 6h2v3h3v-2a3 3 0 0 1 6 0v2h2V4h-3a3 3 0 0 0-6 0z" />,
  remote: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16" />
    </>
  ),
  package: <path d="m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10" />,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <path d="M20 11a8 8 0 0 0-14.5-3L4 10m0 0V5m0 5h5M4 13a8 8 0 0 0 14.5 3L20 14m0 0v5m0-5h-5" />,
  restore: <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6M4 4v4.6h4.6" />,
  review: <path d="M8 2.2 13.6 5v3.4c0 2.6-2.2 4.4-5.6 5.4-3.4-1-5.6-2.8-5.6-5.4V5zM5.9 8l1.5 1.5L10.4 6.6" />,
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.1h-2.5v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1A1.7 1.7 0 0 0 8 15a1.7 1.7 0 0 0-1.5-1H6.4v-2.5h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.1h2.5v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1V14h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  spark: (
    <path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5zM19 16l.6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6z" />
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M22 12h-3M12 22v-3M2 12h3" />
    </>
  ),
  x: <path d="m6 6 12 12M18 6 6 18" />,
};

export function Icon({ name, size = 16 }: IconProps): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
      width={size}
    >
      {paths[name]}
    </svg>
  );
}
