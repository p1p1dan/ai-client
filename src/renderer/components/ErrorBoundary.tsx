import { AlertTriangle } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardPanel,
  CardTitle,
} from '@/components/ui/card';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  className?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: unknown;
  componentStack: string | null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function getErrorStack(error: unknown): string | null {
  if (error instanceof Error) {
    return error.stack ?? null;
  }
  return null;
}

function ErrorFallback({
  className,
  error,
  componentStack,
  onRetry,
}: {
  className?: string;
  error: unknown;
  componentStack: string | null;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const errorMessage = getErrorMessage(error);
  const errorStack = getErrorStack(error);

  return (
    <div className={cn('flex min-h-dvh w-full items-center justify-center p-6', className)}>
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            {t('Error')}
          </CardTitle>
          <CardDescription>
            {t('The app encountered an unexpected error.')}
            <br />
            {t('You can try again, or reload the app.')}
          </CardDescription>
        </CardHeader>

        <CardPanel className="space-y-4">
          <div className="rounded-lg border bg-muted/40 p-3 text-left text-xs font-mono text-foreground">
            {errorMessage}
          </div>

          {errorStack || componentStack ? (
            <details className="group">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
                {t('Error details')}
              </summary>
              <pre className="mt-3 max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words">
                {errorStack ?? ''}
                {componentStack ? `\n\n[componentStack]\n${componentStack}` : ''}
              </pre>
            </details>
          ) : null}
        </CardPanel>

        <CardFooter className="justify-end gap-2">
          <Button onClick={onRetry} variant="secondary">
            {t('Retry')}
          </Button>
          <Button onClick={() => window.location.reload()}>{t('Reload')}</Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    componentStack: null,
  };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null, componentStack: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          className={this.props.className}
          error={this.state.error}
          componentStack={this.state.componentStack}
          onRetry={this.handleRetry}
        />
      );
    }

    return this.props.children;
  }
}
