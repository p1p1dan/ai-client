import { FileX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { useI18n } from '@/i18n';
import { OpenWithSystemViewerButton } from './OpenWithSystemViewerButton';
import { imageDimensionsAllowed, MAX_IMAGE_PIXELS } from './previewResourceLimits';
import { buildPreviewUrl } from './previewUrl';

/** Why the image is not on screen; worded at render time so it follows the locale. */
type ImageError = 'load' | 'too-large';

interface ImagePreviewProps {
  path: string;
}

export function ImagePreview({ path }: ImagePreviewProps) {
  const { t } = useI18n();
  const [scale, setScale] = useState(1);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(
    null
  );
  const [error, setError] = useState<ImageError | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // Convert file path to local-file:// URL (Electron custom protocol). Never
  // throws: a path that cannot become a URL is this component's error state,
  // not a render-time exception for an error boundary to catch.
  const preview = useMemo(() => buildPreviewUrl(path, retryKey), [path, retryKey]);

  // Reset scale when image changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: path change should reset scale
  useEffect(() => {
    setScale(1);
    setImageDimensions(null);
    setError(null);
    setRetryKey(0);
  }, [path]);

  // Handle wheel event for zooming
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let rafId: number | null = null;

    const handleWheel = (e: WheelEvent) => {
      // Only zoom when Ctrl/Cmd is pressed
      if (!e.ctrlKey && !e.metaKey) return;

      e.preventDefault();

      // Cancel previous animation frame
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }

      // Use requestAnimationFrame to throttle updates
      rafId = requestAnimationFrame(() => {
        setScale((prevScale) => {
          const delta = e.deltaY > 0 ? 0.9 : 1.1;
          const newScale = prevScale * delta;
          // Limit scale between 10% and 500%
          return Math.min(Math.max(newScale, 0.1), 5);
        });
        rafId = null;
      });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  // Handle double click to reset scale
  const handleDoubleClick = () => {
    setScale(1);
  };

  // Handle image load to get dimensions
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (!imageDimensionsAllowed(img.naturalWidth, img.naturalHeight)) {
      setImageDimensions(null);
      setError('too-large');
      return;
    }
    setError(null);
    setImageDimensions({
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  };

  if (!preview.ok || error) {
    const description = !preview.ok
      ? t('This path cannot be previewed here.')
      : error === 'too-large'
        ? t('Image dimensions exceed the {{count}} megapixel preview limit.', {
            count: Math.round(MAX_IMAGE_PIXELS / 1_000_000),
          })
        : t(
            'The image could not be loaded. Files outside the open workspace cannot be previewed here, and the file may also be missing or not a valid image.'
          );
    return (
      <Empty className="h-full">
        <EmptyMedia variant="icon">
          <FileX className="h-4.5 w-4.5" />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{t('Image preview unavailable')}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          <OpenWithSystemViewerButton path={path} />
          {preview.ok && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setError(null);
                setRetryKey((value) => value + 1);
              }}
            >
              {t('Retry')}
            </Button>
          )}
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full flex-col items-center justify-center overflow-auto bg-[length:20px_20px]"
      style={{
        backgroundImage: `
          linear-gradient(45deg, hsl(var(--muted)) 25%, transparent 25%),
          linear-gradient(-45deg, hsl(var(--muted)) 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, hsl(var(--muted)) 75%),
          linear-gradient(-45deg, transparent 75%, hsl(var(--muted)) 75%)
        `,
        backgroundSize: '20px 20px',
        backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
      }}
      onDoubleClick={handleDoubleClick}
    >
      {/* Image */}
      <img
        ref={imageRef}
        src={preview.url}
        alt={path.split('/').pop() || 'Preview'}
        className="max-h-full max-w-full object-contain"
        style={{
          transform: `scale(${scale})`,
          willChange: 'transform',
          imageRendering: scale > 1 ? 'auto' : 'crisp-edges',
        }}
        onLoad={handleImageLoad}
        onError={() => {
          setImageDimensions(null);
          setError('load');
        }}
        draggable={false}
      />

      {/* Info bar */}
      {imageDimensions && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-background/80 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
          {imageDimensions.width}×{imageDimensions.height} • {Math.round(scale * 100)}%
        </div>
      )}
    </div>
  );
}
