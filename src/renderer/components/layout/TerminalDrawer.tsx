/**
 * Terminal drawer for the Cursor-style layout.
 * Slides out from the right side of the screen, overlaying the main content area.
 * Replaces the legacy terminal tab with a non-intrusive drawer panel.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { memo } from 'react';
import { TerminalPanel } from '@/components/terminal/TerminalPanel';
import { springStandard } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';

interface TerminalDrawerProps {
  open: boolean;
  onClose: () => void;
  repoPath?: string;
  cwd?: string;
  className?: string;
}

export const TerminalDrawer = memo(function TerminalDrawer({
  open,
  onClose,
  repoPath,
  cwd,
  className,
}: TerminalDrawerProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={springStandard}
          className={cn(
            'fixed inset-y-0 right-0 w-[560px] border-l border-border bg-background shadow-2xl flex flex-col',
            className
          )}
          style={{ zIndex: Z_INDEX.SETTINGS_WINDOW }}
        >
          {/* Header */}
          <div className="h-9 flex items-center px-3 border-b border-border shrink-0">
            <span className="text-xs font-semibold text-muted-foreground">Terminal</span>
            <button
              type="button"
              onClick={onClose}
              className="ml-auto h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label="Close terminal"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* Terminal content */}
          <div className="flex-1 overflow-hidden">
            <TerminalPanel repoPath={repoPath} cwd={cwd} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
