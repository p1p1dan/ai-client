/**
 * The welcome screen's logo: an isometric cube where a soft white glow
 * pulses face to face — top, then right, then left — so the brightness
 * reads as one loop travelling clockwise around the cube rather than three
 * faces doing unrelated things.
 *
 * ## Everything is in this file, and it has to be
 *
 * `scripts/assert-no-webfonts.mjs` guards the packaged build against external
 * assets, and the artifact CSP would block them anyway. So the mark is inline
 * SVG with inline SMIL animation — no image file, no icon font, no runtime
 * library.
 *
 * ## The glow is a second, separate layer — not the fill itself
 *
 * Each face is drawn twice: once as a static `var(--primary)` fill at a fixed
 * opacity (so the mark still reads the theme and re-themes for free, same as
 * before), and once more as a plain white copy whose OPACITY animates
 * 0 -> 0.5 -> 0. Layering a white wash on top like this — rather than
 * animating the fill color itself — means the only thing SMIL ever
 * interpolates is a number, not a color list, which sidesteps engines
 * disagreeing on how to interpolate between two `var(...)` colors.
 *
 * ## A relay, not three independent animations
 *
 * All three glow layers run the SAME 6s cycle, just started a third of a
 * period (2s) apart, in the order top -> right -> left — the clockwise
 * order of this isometric layout's visible perimeter. That stagger is what
 * makes the peak visibly hand off face to face instead of reading as three
 * faces flickering independently.
 *
 * ## Static geometry, only the glow's opacity moves
 *
 * The three faces never move or change shape. `motion-reduce:hidden` on
 * each `<animate>` is the one thing that reaches SMIL from a CSS media
 * query: it forces `display:none` on the animation, which halts it and
 * leaves the plain, glow-free cube (the white layer's own resting opacity
 * is 0, so hiding the animation is enough — nothing else needs to change).
 */

export interface AiClientMarkProps {
  /** Pixel size of the square viewport. Defaults to the welcome screen's 72. */
  size?: number;
}

const FACES = [
  { begin: '-2s', d: 'M60 14 L104 39 L60 64 L16 39 Z', opacity: 0.95 },
  { begin: '0s', d: 'M104 39 L104 85 L60 110 L60 64 Z', opacity: 0.75 },
  { begin: '2s', d: 'M16 39 L60 64 L60 110 L16 85 Z', opacity: 0.55 },
] as const;

const OUTLINE = 'M60 14 L104 39 L104 85 L60 110 L16 85 L16 39 Z';
const SEAMS = ['M16 39 L60 64 L104 39', 'M60 64 L60 110'];

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
      <title>Pilab</title>

      {FACES.map((face) => (
        <path d={face.d} fill="var(--primary)" key={face.d} opacity={face.opacity} />
      ))}

      {FACES.map((face) => (
        <path d={face.d} fill="white" key={`glow-${face.d}`} opacity="0">
          <animate
            attributeName="opacity"
            begin={face.begin}
            calcMode="spline"
            className="motion-reduce:hidden"
            dur="6s"
            keySplines="0.42 0 0.58 1; 0.42 0 0.58 1"
            keyTimes="0; 0.5; 1"
            repeatCount="indefinite"
            values="0; 0.5; 0"
          />
        </path>
      ))}

      {/* Edges, drawn last so the glow never washes the silhouette out. */}
      <g opacity="0.28" stroke="var(--foreground)" strokeLinejoin="round" strokeWidth="1.5">
        <path d={OUTLINE} />
        {SEAMS.map((d) => (
          <path d={d} key={d} />
        ))}
      </g>
    </svg>
  );
}
