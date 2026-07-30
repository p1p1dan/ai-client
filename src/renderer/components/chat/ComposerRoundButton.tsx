import type { VariantProps } from 'class-variance-authority';
import { RotateCcw, SendHorizonal, Square } from 'lucide-react';
import type { ComponentType } from 'react';
import { Button, type buttonVariants } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { roundActionButtonClass } from './middleColumnLayout';

type RoundButtonKind = 'send' | 'stop' | 'retry';

interface ComposerRoundButtonProps {
  kind: RoundButtonKind;
  disabled?: boolean;
  onClick: () => void;
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
};

/**
 * T-28 §3.5: 28px true-circle action button shared by Send / Stop / Retry —
 * color comes from the Button variant, shape from `roundActionButtonClass()`.
 * The three kinds occupy the same slot at the same size (D23 decision 5): the
 * running turn's Stop replaces Send in place, it never grows a pill shape.
 */
export function ComposerRoundButton({ kind, disabled, onClick }: ComposerRoundButtonProps) {
  const { t } = useI18n();
  const { variant, Icon, label } = KIND_CONFIG[kind];
  const title = t(label);

  return (
    <Button
      size="icon-sm"
      variant={variant}
      className={roundActionButtonClass()}
      disabled={disabled}
      onClick={onClick}
      aria-label={title}
      title={title}
    >
      <Icon className="size-3.5" />
    </Button>
  );
}
