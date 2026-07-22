/**
 * Chat input for the Cursor-style chat UI.
 * Wraps the existing EnhancedInput in docked mode for a fixed bottom input bar.
 */

import { useCallback, useState } from 'react';
import { EnhancedInput } from '@/components/chat/EnhancedInput';

interface ChatInputProps {
  onSend: (content: string, imagePaths: string[]) => void;
  cwd?: string;
  repoPath?: string;
  isActive?: boolean;
}

export function ChatInput({ onSend, cwd, repoPath, isActive = true }: ChatInputProps) {
  const [content, setContent] = useState('');
  const [imagePaths, setImagePaths] = useState<string[]>([]);

  const handleSend = useCallback(
    (text: string, images: string[]) => {
      onSend(text, images);
      setContent('');
      setImagePaths([]);
    },
    [onSend]
  );

  return (
    <div className="shrink-0">
      <EnhancedInput
        mode="docked"
        open={true}
        onOpenChange={() => {}}
        onSend={handleSend}
        content={content}
        imagePaths={imagePaths}
        onContentChange={setContent}
        onImagesChange={setImagePaths}
        keepOpenAfterSend={true}
        isActive={isActive}
        cwd={cwd}
        repoPath={repoPath}
      />
    </div>
  );
}
