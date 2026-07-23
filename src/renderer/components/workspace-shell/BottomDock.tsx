import { TerminalSquare, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface BottomDockProps {
  height: number;
  onClose: () => void;
}

export function BottomDock({ height, onClose }: BottomDockProps) {
  return (
    <section className="flex shrink-0 flex-col border-t bg-card/30" style={{ height }}>
      <div className="flex h-9 items-center justify-between border-b px-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <TerminalSquare className="h-4 w-4" />
          Terminal Dock
        </div>
        <Button variant="ghost" size="icon-xs" className="h-6 w-6" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex flex-1 items-center justify-center px-4 text-sm text-muted-foreground">
        Terminal placeholder — existing xterm integration will mount here in Phase 4.
      </div>
    </section>
  );
}
