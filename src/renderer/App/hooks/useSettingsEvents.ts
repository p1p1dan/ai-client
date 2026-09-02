import { useEffect } from 'react';
import type { SettingsCategory } from '@/components/settings/constants';

export function useSettingsEvents(
  openSettings: () => void,
  setSettingsCategory: (category: SettingsCategory) => void
) {
  // Listen for 'open-settings-agent' event
  useEffect(() => {
    const handleOpenSettingsAgent = () => {
      setSettingsCategory('agent');
      openSettings();
    };

    window.addEventListener('open-settings-agent', handleOpenSettingsAgent);
    return () => {
      window.removeEventListener('open-settings-agent', handleOpenSettingsAgent);
    };
  }, [openSettings, setSettingsCategory]);
}
