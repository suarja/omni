import type { ReactElement } from "react";

import type { AcademyIllustration } from "../../shared/academy-ipc";

type IllustrationProps = Readonly<{ pictogram: AcademyIllustration; className?: string }>;

const pictograms: Record<AcademyIllustration, ReactElement> = {
  marketplace: (
    <>
      <path d="M4 10h16l-1.5-4h-13zM5 10v9h14v-9M9 19v-5h6v5" />
      <path d="M4 10h16" />
    </>
  ),
  plugin: <path d="M9 4v3H7a3 3 0 0 0 0 6h2v3h3v-2a3 3 0 0 1 6 0v2h2V4h-3a3 3 0 0 0-6 0z" />,
  skill: (
    <>
      <path d="M6 4h9l3 3v13H6z" />
      <path d="M15 4v4h4M9 12h6M9 16h4" />
    </>
  ),
  project: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  agent: (
    <>
      <circle cx="12" cy="8" r="3" />
      <path d="M5 20a7 7 0 0 1 14 0M4 12h3M17 12h3" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
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
  terminal: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="m8 10 3 2-3 2M13 15h3" />
    </>
  ),
  "claude-code": (
    <>
      <path d="M6 8a6 6 0 0 1 12 0v4a6 6 0 0 1-12 0z" />
      <path d="M9 11h.01M15 11h.01M9 15c2 1 4 1 6 0" />
    </>
  ),
  codex: (
    <>
      <path d="M5 7.5 12 4l7 3.5v9L12 20l-7-3.5z" />
      <path d="M8 9.5 12 12l4-2.5M12 12v8" />
    </>
  ),
  lesson: (
    <>
      <path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v16H7.5A2.5 2.5 0 0 0 5 21z" />
      <path d="M5 5.5v15M9 7h6M9 11h6" />
    </>
  ),
  course: (
    <>
      <path d="M4 6.5 12 3l8 3.5L12 10z" />
      <path d="M7 8v7c2 2 8 2 10 0V8M20 7v7" />
    </>
  ),
};

function groundFor(pictogram: AcademyIllustration): "sage" | "rose" | "sand" {
  const sage: readonly AcademyIllustration[] = ["skill", "project", "git", "codex"];
  const rose: readonly AcademyIllustration[] = ["plugin", "agent", "receipt", "claude-code"];
  if (sage.includes(pictogram)) return "sage";
  if (rose.includes(pictogram)) return "rose";
  return "sand";
}

export function Illustration({ className, pictogram }: IllustrationProps): ReactElement {
  return (
    <span
      className={`academy-illustration academy-illustration--${groundFor(pictogram)}${className ? ` ${className}` : ""}`}
      data-testid={`illustration-${pictogram}`}
    >
      <svg
        aria-hidden="true"
        fill="none"
        height="72"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
        viewBox="0 0 24 24"
        width="72"
      >
        {pictograms[pictogram]}
      </svg>
    </span>
  );
}
