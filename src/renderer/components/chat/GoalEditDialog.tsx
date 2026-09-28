/**
 * dsh-rebase P1-7a: the goal bar's 「编辑目标」 — a new objective for the current
 * goal, run as DSH's `/goal edit <objective>` (plan P1-7 shard 03 §2). The
 * round count and phase stay; a completed goal is replaced by a new one, as
 * DSH's own command does. The dialog stays open until DSH has taken it, so a
 * refusal (a toast from the bar) leaves the text to fix.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';

export function GoalEditDialog({
  open,
  objective,
  pending,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  objective: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (objective: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(objective);
  // Each opening starts from the goal as it is now.
  useEffect(() => {
    if (open) setDraft(objective);
  }, [open, objective]);
  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && trimmed !== objective.trim() && !pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Edit goal')}</DialogTitle>
          <DialogDescription>
            {t('The assistant works toward the new objective from its next round.')}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={t('Goal objective')}
            rows={4}
            autoFocus
          />
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="outline" />}>{t('Cancel')}</DialogClose>
          <Button disabled={!canSave} onClick={() => void onSave(trimmed)}>
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
