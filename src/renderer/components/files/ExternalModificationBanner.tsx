import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/i18n';

interface ExternalModificationBannerProps {
  onReload: () => void;
  onDismiss: () => void;
}

export function ExternalModificationBanner({
  onReload,
  onDismiss,
}: ExternalModificationBannerProps) {
  const { t } = useI18n();

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border-soft bg-warning/8 px-3 py-1.5 text-small text-warning">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t('File changed externally')}</span>
      <button
        type="button"
        onClick={onReload}
        className="shrink-0 rounded-xs px-2 py-0.5 font-medium transition-colors hover:bg-warning/16"
      >
        {t('Reload')}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-xs px-2 py-0.5 transition-colors hover:bg-warning/16"
      >
        {t('Keep Mine')}
      </button>
    </div>
  );
}
