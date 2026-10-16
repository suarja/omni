import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const rendererStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const canvasStyles = readFileSync(new URL("../canvas/canvas.css", import.meta.url), "utf8");
const primitiveStyles = readFileSync(new URL("../components/ui/ui.css", import.meta.url), "utf8");

describe("theme token contract", () => {
  it("keeps the light palette aligned with Candidate C", () => {
    const expectedValues = {
      "--color-desktop": "oklch(90% 0.004 85)",
      "--color-canvas": "oklch(95.8% 0.004 85)",
      "--color-sidebar": "oklch(93.8% 0.005 85)",
      "--color-panel": "oklch(99.4% 0 0)",
      "--color-panel-top": "oklch(100% 0 0)",
      "--color-panel-bottom": "oklch(98.4% 0.003 85)",
      "--color-panel-highlight": "oklch(100% 0 0 / .9)",
      "--color-nested": "oklch(97.2% 0.003 85)",
      "--color-field": "var(--color-nested)",
      "--color-hover": "oklch(97.2% 0.004 85)",
      "--color-press": "oklch(94.2% 0.005 85)",
      "--color-selection": "oklch(92.5% 0.006 85)",
      "--color-border": "oklch(89.5% 0.005 85)",
      "--color-border-strong": "oklch(84.5% 0.007 85)",
      "--color-ink": "oklch(23% 0.008 80)",
      "--color-ink-muted": "oklch(42% 0.008 80)",
      "--color-ink-faint": "oklch(53% 0.007 80)",
      "--color-primary": "oklch(21% 0.008 80)",
      "--color-on-primary": "oklch(99% 0 0)",
      "--color-primary-hover": "oklch(30% 0.008 80)",
      "--color-success": "oklch(48% 0.13 150)",
      "--color-warning": "oklch(50% 0.12 68)",
      "--color-danger": "oklch(50% 0.18 27)",
      "--color-success-soft": "oklch(95.5% 0.035 150)",
      "--color-warning-soft": "oklch(95.8% 0.04 80)",
      "--color-danger-soft": "oklch(95.8% 0.03 25)",
      "--color-neutral-soft": "oklch(94.6% 0.004 85)",
      "--color-icon-top": "oklch(97% 0.004 85)",
      "--color-icon-bottom": "oklch(92.5% 0.006 85)",
      "--color-code": "oklch(96.5% 0.004 85)",
      "--color-focus": "oklch(55% 0.16 255)",
    };

    for (const [name, value] of Object.entries(expectedValues)) {
      expect(tokens).toContain(`${name}: ${value};`);
    }
    expect(tokens).toContain("--color-sidebar-ink: var(--color-ink);");
    expect(tokens).toContain("--color-sidebar-ink-muted: var(--color-ink-muted);");
    expect(tokens).toContain("--color-sidebar-ink-faint: var(--color-ink-faint);");
    expect(tokens).toContain("--color-avatar: oklch(88% 0.006 85);");
    expect(tokens).toContain("--color-avatar-ink: oklch(35% 0.008 80);");
  });

  it("keeps the dark palette aligned with Candidate C", () => {
    const expectedValues = {
      "--color-desktop": "oklch(12% 0.004 260)",
      "--color-canvas": "oklch(17.5% 0.006 260)",
      "--color-sidebar": "oklch(15% 0.006 260)",
      "--color-panel": "oklch(24% 0.008 260)",
      "--color-panel-top": "oklch(25.5% 0.008 260)",
      "--color-panel-bottom": "oklch(22.5% 0.008 260)",
      "--color-panel-highlight": "oklch(100% 0 0 / .06)",
      "--color-field": "var(--color-nested)",
      "--color-hover": "oklch(28% 0.009 260)",
      "--color-press": "oklch(30% 0.009 260)",
      "--color-selection": "oklch(30% 0.01 260)",
      "--color-border": "oklch(30% 0.009 260)",
      "--color-border-strong": "oklch(35% 0.01 260)",
      "--color-ink": "oklch(96% 0.002 85)",
      "--color-ink-muted": "oklch(81% 0.006 260)",
      "--color-ink-faint": "oklch(69% 0.008 260)",
      "--color-primary": "oklch(95% 0.002 85)",
      "--color-on-primary": "oklch(17% 0.006 260)",
      "--color-primary-hover": "oklch(86% 0.004 85)",
      "--color-success": "oklch(80% 0.14 150)",
      "--color-warning": "oklch(84% 0.13 80)",
      "--color-danger": "oklch(74% 0.16 27)",
      "--color-success-soft": "oklch(29% 0.05 150)",
      "--color-warning-soft": "oklch(30% 0.05 80)",
      "--color-danger-soft": "oklch(29% 0.06 25)",
      "--color-neutral-soft": "oklch(30% 0.009 260)",
      "--color-icon-top": "oklch(33% 0.012 260)",
      "--color-icon-bottom": "oklch(26% 0.01 260)",
      "--color-code": "oklch(20% 0.007 260)",
      "--color-focus": "oklch(72% 0.14 255)",
    };

    for (const [name, value] of Object.entries(expectedValues)) {
      expect(tokens).toContain(`${name}: ${value};`);
    }
    expect(tokens).toContain("--color-sidebar-ink: var(--color-ink);");
    expect(tokens).toContain("--color-sidebar-ink-muted: var(--color-ink-muted);");
    expect(tokens).toContain("--color-sidebar-ink-faint: var(--color-ink-faint);");
    expect(tokens).toContain("--color-avatar: oklch(32% 0.008 260);");
    expect(tokens).toContain("--color-avatar-ink: oklch(88% 0.003 85);");
  });

  it("defines the Candidate C geometry tokens", () => {
    const expectedTokens = [
      "--radius-card: 12px;",
      "--radius-control: 8px;",
      "--radius-badge: 6px;",
      "--radius-pill: 999px;",
      "--radius-panel: var(--radius-card);",
      "--control-height-sm: 28px;",
      "--control-height: 32px;",
      "--control-height-lg: 40px;",
      "--shadow-drawer: 0 8px 24px rgba(0, 0, 0, 0.08);",
    ];

    for (const expectedToken of expectedTokens) {
      expect(tokens).toContain(expectedToken);
    }
  });

  it("keeps soft state tokens independent from color-mix", () => {
    expect(tokens).not.toMatch(/--color-[^:]+-soft:\s*[^;]*color-mix/);
  });

  it("uses readable canvas roles after removing the classic sidebar", () => {
    expect(rendererStyles).not.toContain(".sidebar");
    expect(canvasStyles).toContain("color: var(--canvas-muted);");
    expect(canvasStyles).toContain("color: var(--canvas-ink);");
  });

  it("centralizes the readable typography scale", () => {
    expect(tokens).toContain('--font-mono: ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace;');
    // The four-size scale (owner, 2026-09-16): nothing else defines a font size.
    expect(tokens).toContain("--font-size-title: 30px;");
    expect(tokens).toContain("--font-size-section: 20px;");
    expect(tokens).toContain("--font-size-body: 15px;");
    expect(tokens).toContain("--font-size-meta: 13px;");
    expect(tokens.match(/--font-size-[a-z-]+:/g)).toHaveLength(4);
    expect(tokens).toContain("--font-weight-semibold: 600;");
    expect(tokens).toContain("--line-height-body: 1.45;");
  });

  it("defines the display serif stack for titles (correction 8)", () => {
    expect(tokens).toContain('--font-display: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;');
    expect(tokens).toContain("--font-size-section: 20px;");
  });

  it("keeps renderer typography on theme tokens", () => {
    const css = `${rendererStyles}\n${primitiveStyles}`;

    expect(css).not.toMatch(/font-size:\s*\d+px/);
    expect(css).not.toMatch(/font-weight:\s*\d+/);
    expect(css).not.toMatch(/line-height:\s*[\d.]+(?:px)?/);
  });

  it("keeps UI primitives free of motion and drop shadows", () => {
    expect(primitiveStyles).not.toMatch(/translateY/);
    expect(primitiveStyles).not.toMatch(/transform\s*:/);

    const shadows = primitiveStyles.match(/box-shadow\s*:[^;]+;/g) ?? [];
    expect(
      shadows.every((shadow) =>
        [
          "box-shadow: inset 0 0 0 1px var(--color-border-strong);",
          "box-shadow: inset 0 1px 0 var(--color-panel-highlight);",
          "box-shadow: inset 0 1px 0 var(--color-panel-highlight), 0 0 0 1px var(--color-border-strong);",
          "box-shadow: none;",
        ].includes(shadow),
      ),
    ).toBe(true);
  });

  it("uses Candidate C geometry and palette roles for UI primitives", () => {
    expect(primitiveStyles).toContain("border-radius: var(--radius-control);");
    expect(primitiveStyles).toContain("font-weight: var(--font-weight-medium);");
    expect(primitiveStyles).toContain("min-height: var(--control-height);");
    expect(primitiveStyles).toContain("padding: 0 14px;");
    expect(primitiveStyles).toContain("min-height: var(--control-height-sm);");
    expect(primitiveStyles).toContain("padding: 0 12px;");
    expect(primitiveStyles).toContain("font-size: var(--font-size-meta);");
    expect(primitiveStyles).toContain("height: var(--control-height);");
    expect(primitiveStyles).toContain("background: var(--color-nested);");
    expect(primitiveStyles).toContain("border-radius: var(--radius-badge);");
    expect(primitiveStyles).toContain("background: var(--color-hover);");
    expect(primitiveStyles).toContain("border-radius: var(--radius-card);");
    expect(primitiveStyles).toContain("outline: 2px solid var(--color-focus);");
  });

  it("does not retain the superseded warm hex palette", () => {
    expect(tokens).not.toContain("#fbf8f2");
    expect(tokens).not.toContain("#f2eee6");
    expect(tokens).not.toContain("#17191c");
  });
});
