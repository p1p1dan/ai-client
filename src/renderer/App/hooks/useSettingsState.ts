import { useCallback, useEffect, useRef, useState } from 'react';
import { isSettingsCategory, type SettingsCategory } from '@/components/settings/constants';
import { useSettingsStore } from '@/stores/settings';
import type { TabId } from '../constants';

export function useSettingsState(
  activeTab: TabId,
  previousTab: TabId | null,
  setActiveTab: (tab: TabId) => void,
  setPreviousTab: (tab: TabId | null) => void
) {
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>(() => {
    try {
      const saved = localStorage.getItem('aiclient-settings-active-category');
      // Validated against the one category list, not a copy of it: a pane that
      // was missing from the copy opened once and never reopened after a
      // restart, and nothing about that reads as a bug.
      return isSettingsCategory(saved) ? saved : 'general';
    } catch {
      return 'general';
    }
  });
  const [scrollToProvider, setScrollToProvider] = useState(false);
  const [pendingProviderAction, setPendingProviderAction] = useState<'preview' | 'save' | null>(
    null
  );
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);

  const settingsDisplayMode = useSettingsStore((s) => s.settingsDisplayMode);
  const useOpenChamberShell = useSettingsStore((s) => s.useOpenChamberShell);
  // OpenChamber shell replaces the main tab surface — force modal settings
  // there. T-16: the dev-flag term is gone, so the legacy shell gets its
  // `settingsDisplayMode: 'tab'` behaviour back once the switch is off.
  const forceSettingsModal = useOpenChamberShell;
  const prevSettingsDisplayModeRef = useRef<typeof settingsDisplayMode | null>(null);

  // Persist settings category
  useEffect(() => {
    try {
      localStorage.setItem('aiclient-settings-active-category', settingsCategory);
    } catch (error) {
      console.warn('Failed to save settings category:', error);
    }
  }, [settingsCategory]);

  const openSettings = useCallback(() => {
    if (settingsDisplayMode === 'tab' && !forceSettingsModal) {
      if (activeTab !== 'settings') {
        setPreviousTab(activeTab);
        setActiveTab('settings');
      }
      return;
    }
    setSettingsDialogOpen(true);
  }, [settingsDisplayMode, forceSettingsModal, activeTab, setActiveTab, setPreviousTab]);

  const toggleSettings = useCallback(() => {
    if (settingsDisplayMode === 'tab' && !forceSettingsModal) {
      if (activeTab === 'settings') {
        setActiveTab(previousTab || 'chat');
        setPreviousTab(null);
      } else {
        setPreviousTab(activeTab);
        setActiveTab('settings');
      }
      return;
    }
    setSettingsDialogOpen((prev) => !prev);
  }, [
    settingsDisplayMode,
    forceSettingsModal,
    activeTab,
    previousTab,
    setActiveTab,
    setPreviousTab,
  ]);

  const handleSettingsCategoryChange = useCallback((category: SettingsCategory) => {
    setSettingsCategory(category);
  }, []);

  // Clean up settings state when display mode changes (not when shell forces modal).
  useEffect(() => {
    const prevMode = prevSettingsDisplayModeRef.current;
    prevSettingsDisplayModeRef.current = settingsDisplayMode;

    if (prevMode === null || prevMode === settingsDisplayMode) {
      return;
    }

    if (settingsDisplayMode === 'tab' && !forceSettingsModal) {
      setSettingsDialogOpen(false);
      if (activeTab !== 'settings') {
        setPreviousTab(activeTab);
        setActiveTab('settings');
      }
      return;
    }

    if (activeTab === 'settings') {
      setActiveTab(previousTab || 'chat');
      setPreviousTab(null);
    }
    // Do not auto-open the modal on mode switch — user opens Settings explicitly.
  }, [
    settingsDisplayMode,
    forceSettingsModal,
    activeTab,
    previousTab,
    setActiveTab,
    setPreviousTab,
  ]);

  return {
    settingsCategory,
    scrollToProvider,
    pendingProviderAction,
    settingsDialogOpen,
    settingsDisplayMode,
    forceSettingsModal,
    setSettingsCategory,
    setScrollToProvider,
    setPendingProviderAction,
    setSettingsDialogOpen,
    openSettings,
    toggleSettings,
    handleSettingsCategoryChange,
  };
}
