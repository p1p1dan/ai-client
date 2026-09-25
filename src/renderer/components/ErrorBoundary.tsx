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
import { errorMessageOf, errorStackOf, formatErrorReport } from './errorReport';

interface ErrorBoundaryProps {
  children?: React.ReactNode;
  className?: string;
  /**
   * Names the boundary in the log line (`[ErrorBoundary:<scope>]`), so a
   * report says WHICH part of the window failed. Absent on the root one.
   */
  scope?: string;
  /**
   * When this value changes while the fallback is showing, the boundary
   * retries on its own — e.g. the editor column's active tab, so closing or
   * switching away from the file that failed brings the column back.
   */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: unknown;
  componentStack: string | null;
}

/** How long the copy button reads "Copied" before reverting. */
const COPY_CONFIRM_MS = 1500;

function ErrorFallback({
  className,
  error,
  componentStack,
  scope,
  onRetry,
}: {
  className?: string;
  error: unknown;
  componentStack: string | null;
  scope?: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);
  const errorMessage = errorMessageOf(error);
  const errorStack = errorStackOf(error);

  React.useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formatErrorReport({ error, componentStack, scope }));
    } catch {
      // Claiming "Copied" after a failed write would be worse than no feedback.
      return;
    }
    setCopied(true);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
  };

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
              <pre className="mt-3 max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-code leading-relaxed text-foreground whitespace-pre-wrap break-words">
                {errorStack ?? ''}
                {componentStack ? `\n\n[componentStack]\n${componentStack}` : ''}
              </pre>
            </details>
          ) : null}
        </CardPanel>

        <CardFooter className="justify-end gap-2">
          <Button onClick={() => void handleCopy()} variant="outline">
            {copied ? t('Copied') : t('Copy error details')}
          </Button>
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
    const componentStack = info.componentStack ?? null;
    // One string, not `(error, stack)`: `console` is electron-log's in the app
    // (`renderer/index.tsx`), and `error` level always crosses its IPC to the
    // main-process log file. A pre-formatted report reads the same there no
    // matter how the transport would have serialised an Error object.
    console.error(formatErrorReport({ error, componentStack, scope: this.props.scope }));
    this.setState({ componentStack });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.hasError && !Object.is(prevProps.resetKey, this.props.resetKey)) {
      this.handleRetry();
    }
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
          scope={this.props.scope}
          onRetry={this.handleRetry}
        />
      );
    }

    return this.props.children;
  }
}
