import { Settings } from 'lucide-react';
import { type ReactElement, useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogPopup, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useKeybindingInterceptor } from '@/hooks/useKeybindingInterceptor';
import { useI18n } from '@/i18n';
import type { SettingsCategory } from './constants';
import { SettingsContent } from './SettingsContent';

interface SettingsDialogProps {
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  activeCategory?: SettingsCategory;
  onCategoryChange?: (category: SettingsCategory) => void;
  repoPath?: string;
}

export function SettingsDialog({
  trigger,
  open,
  onOpenChange,
  activeCategory,
  onCategoryChange,
  repoPath,
}: SettingsDialogProps) {
  const { t } = useI18n();
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange]
  );
  const handleClose = useCallback(() => handleOpenChange(false), [handleOpenChange]);
  useKeybindingInterceptor(isOpen, 'closeTab', handleClose);
  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {open === undefined && (
        <DialogTrigger
          render={
            trigger ?? (
              <Button variant="ghost" size="icon" aria-label={t('Settings')}>
                <Settings className="h-4 w-4" />
              </Button>
            )
          }
        />
      )}
      <DialogPopup
        className="flex h-[min(720px,90dvh)] max-w-[95vw] flex-col overflow-hidden p-0 sm:max-w-5xl"
        showCloseButton
        disableNestedTransform
      >
        <div className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="text-lg font-medium">{t('Settings')}</DialogTitle>
        </div>
        <div className="min-h-0 flex-1">
          <SettingsContent
            activeCategory={activeCategory}
            onCategoryChange={onCategoryChange}
            repoPath={repoPath}
          />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
