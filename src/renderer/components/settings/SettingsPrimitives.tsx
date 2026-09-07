import type { ComponentProps, ReactNode } from 'react';
import { Field } from '@/components/ui/field';
import { cn } from '@/lib/utils';

export function SettingsPageShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </div>
  );
}

export function SettingsSectionBlock({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-4 border-t pt-4 first:border-t-0 first:pt-0">
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
      </div>
      {children}
    </section>
  );
}

export function SettingsRow({ className, ...props }: ComponentProps<typeof Field>) {
  return (
    <Field
      className={cn(
        'grid min-w-0 grid-cols-1 items-start gap-2 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4',
        className
      )}
      {...props}
    />
  );
}
