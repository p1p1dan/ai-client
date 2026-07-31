import type { VariantProps } from 'class-variance-authority';
import { ListPlus, RotateCcw, SendHorizonal, Square } from 'lucide-react';
import type { ComponentType } from 'react';
import { Button, type buttonVariants } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { roundActionButtonClass, roundActionButtonKindClass } from './middleColumnLayout';

type RoundButtonKind = 'send' | 'stop' | 'retry' | 'enqueue';

interface ComposerRoundButtonProps {
  kind: RoundButtonKind;
  disabled?: boolean;
  onClick: () => void;
  /** T-19: override the accessible label/tooltip — e.g. Retry appending the
   *  recovered attachment count once commit-time consumption makes those
   *  attachments invisible in the draft area (design decision 2.2's
   *  compensation). Falls back to the kind's default i18n label. */
  title?: string;
}

interface RoundButtonKindConfig {
  variant: VariantProps<typeof buttonVariants>['variant'];
  Icon: ComponentType<{ className?: string }>;
  label: string;
}

const KIND_CONFIG: Record<RoundButtonKind, RoundButtonKindConfig> = {
  send: { variant: 'default', Icon: SendHorizonal, label: 'Send message' },
  stop: { variant: 'destructive', Icon: Square, label: 'Stop the running turn' },
  retry: { variant: 'outline', Icon: RotateCcw, label: 'Retry last message' },
  // T-19 decision 2.5: the fourth kind — "send, only delayed". `variant:
  // 'default'` on purpose (not a demoted 'secondary'): it IS the send action
  // for this turn, not an optional extra.
  enqueue: { variant: 'default', Icon: ListPlus, label: 'Queue message' },
};

/**
 * T-28 §3.5 / T-30b2 拍板 ③: 24px true-circle action button shared by Send /
 * Stop / Retry / Enqueue (T-19) — shape from `roundActionButtonClass()`,
 * color from `roundActionButtonKindClass()` layered over the Button variant
 * (send/enqueue fill near-black `--foreground`, the composer's only
 * remaining high-saturation object is the destructive Stop). All kinds
 * occupy the same slot at the same size (D23 decision 5): a running turn's
 * Stop replaces Send in place, it never grows a pill shape — the argument
 * that keeps this key same-position/same-size survives 拍板 ③ unchanged.
 */
export function ComposerRoundButton({
  kind,
  disabled,
  onClick,
  title: titleOverride,
}: ComposerRoundButtonProps) {
  const { t } = useI18n();
  const { variant, Icon, label } = KIND_CONFIG[kind];
  const title = titleOverride ?? t(label);

  return (
    <Button
      size="icon-sm"
      variant={variant}
      className={cn(roundActionButtonClass(), roundActionButtonKindClass(kind))}
      disabled={disabled}
      onClick={onClick}
      aria-label={title}
      title={title}
    >
      {/* 12px icon inside the 24px circle (was 14-in-28). */}
      <Icon className="size-3" />
    </Button>
  );
}
