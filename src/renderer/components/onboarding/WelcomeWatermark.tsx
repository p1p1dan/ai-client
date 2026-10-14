import { ShieldCheckIcon } from 'lucide-react';
import { useId } from 'react';

/**
 * Welcome-screen-only watermark (user ruling 2026-10-14): a sparse diagonal
 * `JYW · SECURE CLIENT` tile at 5% ink plus a two-line signature bottom-right.
 * It never reaches the workspace — only `WelcomeShell` mounts it.
 *
 * The tile fades out radially behind the logo and login button so the
 * centre stays clean. Inline SVG, so nothing external is fetched (see
 * `scripts/assert-no-webfonts.mjs`).
 */

const TILE_TEXT = 'JYW · SECURE CLIENT';
const TILE_W = 520;
const TILE_H = 300;
const CENTRE_FADE =
  'radial-gradient(ellipse 34% 40% at 50% 50%, transparent 0%, transparent 55%, #000 100%)';

function TileLabel({ x, y }: { x: number; y: number }) {
  return (
    <text
      fontSize={13}
      fontWeight={600}
      letterSpacing={4}
      textAnchor="middle"
      transform={`rotate(-24 ${x} ${y})`}
      x={x}
      y={y}
    >
      {TILE_TEXT}
    </text>
  );
}

export function WelcomeWatermark() {
  const patternId = useId();
  return (
    <>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full select-none fill-current text-foreground opacity-5"
        style={{ maskImage: CENTRE_FADE, WebkitMaskImage: CENTRE_FADE }}
      >
        <defs>
          <pattern height={TILE_H} id={patternId} patternUnits="userSpaceOnUse" width={TILE_W}>
            <TileLabel x={TILE_W * 0.25} y={TILE_H * 0.3} />
            <TileLabel x={TILE_W * 0.75} y={TILE_H * 0.8} />
          </pattern>
        </defs>
        <rect fill={`url(#${patternId})`} height="100%" width="100%" />
      </svg>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-5 bottom-4 select-none text-right text-2xs text-muted-foreground tracking-wider"
      >
        <div className="flex items-center justify-end gap-1.5 font-medium">
          <ShieldCheckIcon className="size-3 opacity-80" />© 2026 JYW · Exclusive Edition
        </div>
        <div className="opacity-70">Authorized use only</div>
      </div>
    </>
  );
}
