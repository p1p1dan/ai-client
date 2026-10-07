import { Loader2Icon } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2Icon>) {
  const { t } = useI18n();
  return (
    <Loader2Icon
      // Decision 156: read aloud, so in the UI language. Callers that know what
      // is loading pass their own label.
      aria-label={t('Loading')}
      className={cn('animate-spin', className)}
      role="status"
      {...props}
    />
  );
}

export { Spinner };
