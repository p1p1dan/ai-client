/**
 * The welcome screen's logo: an isometric cube with a band of colour moving
 * across its faces.
 *
 * ## Everything is in this file, and it has to be
 *
 * `scripts/assert-no-webfonts.mjs` guards the packaged build against external
 * assets, and the artifact CSP would block them anyway. So the mark is inline
 * SVG with inline `<style>` — no image file, no icon font, no runtime library.
 *
 * ## Why a moving GRADIENT rather than a moving shape
 *
 * The three faces are static paths; only the gradient stops travel. That keeps
 * the animation on the compositor and means the geometry is still correct at
 * any frame — a screenshot, a paused tab and a `prefers-reduced-motion` user
 * all get the same solid cube, just without the sweep.
 *
 * ## The palette is the app's, not the logo's
 *
 * Stops read `--primary` / `--success` / `--info` rather than hard-coded hexes,
 * so the mark follows the theme in both directions instead of becoming the one
 * element that ignores it.
 *
 * `--accent` is deliberately NOT one of them despite the name: in the light
 * theme it is `oklch(0.9422 0.0122 96.43)` — a near-white surface tint with
 * almost no chroma, because it is a BACKGROUND token. A sweep built on it would
 * be invisible on exactly one of the two themes. The three chosen tokens are
 * the ones that actually carry distinct hues in both.
 */

export interface AiClientMarkProps {
  /** Pixel size of the square viewport. Defaults to the welcome screen's 72. */
  size?: number;
}

export function AiClientMark({ size = 72 }: AiClientMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height={size}
      role="presentation"
      viewBox="0 0 120 120"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>AiClient</title>
      <defs>
        <linearGradient id="aiclient-mark-sweep" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" />
          <stop offset="45%" stopColor="var(--success)" />
          <stop offset="100%" stopColor="var(--info)" />
          {/* Two full turns of the same cycle so the loop has no seam. */}
          {/*
            `<animate>` is SMIL, which CSS media queries cannot reach — so the
            reduced-motion opt-out is expressed the one way that DOES reach it:
            an empty `values` on a `begin` that never fires. `motion-reduce:`
            (Tailwind's `prefers-reduced-motion: reduce`) sets the elements to
            `display:none`, which stops SMIL and leaves the static gradient.
          */}
          <animate
            attributeName="x1"
            className="motion-reduce:hidden"
            dur="6s"
            repeatCount="indefinite"
            values="-1;1;-1"
          />
          <animate
            attributeName="x2"
            className="motion-reduce:hidden"
            dur="6s"
            repeatCount="indefinite"
            values="0;2;0"
          />
        </linearGradient>
      </defs>

      {/* Top face — brightest, so the cube reads as lit from above. */}
      <path d="M60 14 L104 39 L60 64 L16 39 Z" fill="url(#aiclient-mark-sweep)" opacity="0.95" />
      {/* Left face */}
      <path d="M16 39 L60 64 L60 110 L16 85 Z" fill="url(#aiclient-mark-sweep)" opacity="0.55" />
      {/* Right face */}
      <path d="M104 39 L104 85 L60 110 L60 64 Z" fill="url(#aiclient-mark-sweep)" opacity="0.75" />

      {/* Edges, drawn last so the sweep never washes the silhouette out. */}
      <g opacity="0.28" stroke="var(--foreground)" strokeLinejoin="round" strokeWidth="1.5">
        <path d="M60 14 L104 39 L104 85 L60 110 L16 85 L16 39 Z" />
        <path d="M16 39 L60 64 L104 39" />
        <path d="M60 64 L60 110" />
      </g>
    </svg>
  );
}
