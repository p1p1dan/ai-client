import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';

interface RightDockProps {
  activeTab: 'git' | 'files' | 'context';
  onTabChange: (tab: 'git' | 'files' | 'context') => void;
  width: number;
  onClose: () => void;
}

export function RightDock({ activeTab, onTabChange, width, onClose }: RightDockProps) {
  return (
    <aside className="flex h-full shrink-0 flex-col border-l bg-card/30" style={{ width }}>
      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange(value as 'git' | 'files' | 'context')}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="flex h-9 items-center justify-between border-b px-2">
          <TabsList className="h-9 w-full justify-start bg-transparent p-0">
            <TabsTab value="git" className="h-9 px-3">
              Git
            </TabsTab>
            <TabsTab value="files" className="h-9 px-3">
              Files
            </TabsTab>
            <TabsTab value="context" className="h-9 px-3">
              Context
            </TabsTab>
          </TabsList>
          <Button variant="ghost" size="icon-xs" className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <TabsPanel value="git" className="min-h-0 flex-1">
          <DockPlaceholder
            title="Git panel"
            description="Source control will mount here in Phase 4."
          />
        </TabsPanel>
        <TabsPanel value="files" className="min-h-0 flex-1">
          <DockPlaceholder title="Files panel" description="Workspace file tree placeholder." />
        </TabsPanel>
        <TabsPanel value="context" className="min-h-0 flex-1">
          <DockPlaceholder
            title="Context panel"
            description="Session context metadata placeholder."
          />
        </TabsPanel>
      </Tabs>
    </aside>
  );
}

function DockPlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 p-3">
        <p className="text-sm font-medium text-primary">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
        <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-xs text-muted-foreground">
          Mock dock content
        </div>
      </div>
    </ScrollArea>
  );
}
