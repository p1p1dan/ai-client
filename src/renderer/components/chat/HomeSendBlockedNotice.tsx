import { Lock } from 'lucide-react';
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

interface HomeSendBlockedNoticeProps {
  repositoryName: string;
  /** The branch picked on the home page, which cannot be switched to now. */
  branch: string;
  /** The branch the checkout is on; `null` when it could not be read. */
  currentBranch: string | null;
  onSendOnCurrent: () => void;
  onCancel: () => void;
  className?: string;
}

/**
 * Decision 174 (issue #6, user ruling 2026-10-10): a branch was picked on the
 * home page, and by the time of the send a conversation is running in that
 * checkout. Nothing was sent and nothing was switched; the message is still in
 * the box. Two ways on: send on the branch the checkout is on, or cancel and
 * wait.
 *
 * The same coss `Alert` and the same place as `ModelMissingNotice` (above the
 * card, `mb-2`), in its warning form. Its buttons carry `sm:text-meta`: the
 * `xs` size is 12px on desktop and both labels are CJK.
 */
export function HomeSendBlockedNotice({
  repositoryName,
  branch,
  currentBranch,
  onSendOnCurrent,
  onCancel,
  className,
}: HomeSendBlockedNoticeProps) {
  const { t } = useI18n();

  return (
    <Alert variant="warning" className={className} data-home-send-blocked="">
      <Lock />
      <AlertTitle>
        {t('{{repo}} has a chat running — it cannot switch to {{branch}} now', {
          repo: repositoryName,
          branch,
        })}
      </AlertTitle>
      <AlertAction>
        <Button size="xs" variant="outline" className="h-6 sm:text-meta" onClick={onSendOnCurrent}>
          {currentBranch
            ? t('Send on {{branch}} instead', { branch: currentBranch })
            : t('Send on the current branch instead')}
        </Button>
        <Button size="xs" variant="ghost" className="h-6 sm:text-meta" onClick={onCancel}>
          {t('Cancel')}
        </Button>
      </AlertAction>
    </Alert>
  );
}
