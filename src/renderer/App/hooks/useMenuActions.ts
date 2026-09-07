import { useEffect } from 'react';

export function useMenuActions(openSettings: () => void) {
  useEffect(() => {
    const cleanup = window.electronAPI.menu.onAction((action) => {
      switch (action) {
        case 'open-settings':
          openSettings();
          break;
      }
    });
    return cleanup;
  }, [openSettings]);
}
