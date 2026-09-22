import type { ComponentProps } from "react";

// Line icons for the view switcher, drawn to match the rare-ui GooeyNav demo's set: a 24
// grid, 2px stroke, square caps, and `currentColor` so each one takes its tab's label
// colour — gray at rest, white on the active segment. GooeyNav sizes them to the label.

type IconProps = ComponentProps<"svg">;

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "square",
  strokeMiterlimit: 10,
  "aria-hidden": true,
} as const;

export function AlertIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3 22 20H2L12 3Z" strokeLinejoin="round" />
      <line x1="12" y1="10" x2="12" y2="13.5" />
      <circle cx="12" cy="16.75" r="1.25" fill="currentColor" strokeWidth={0} />
    </svg>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="16" y1="2" x2="16" y2="6" />
    </svg>
  );
}

export function AnalysisIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <polyline points="2 17 8 11 13 15 22 6" strokeLinejoin="round" />
      <polyline points="16 6 22 6 22 12" />
    </svg>
  );
}
