import type { ContentSearchMatch, ContentSearchResult, FileSearchResult } from '@shared/types';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SearchMode = 'files' | 'content';

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  filePattern: string;
  useGitignore: boolean;
}

export interface GlobalSearchState {
  mode: SearchMode;
  query: string;
  options: SearchOptions;
  fileResults: FileSearchResult[];
  contentResults: ContentSearchResult | null;
  selectedIndex: number;
  isLoading: boolean;
}

const DEFAULT_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  filePattern: '',
  useGitignore: true,
};

export function useGlobalSearch(rootPath: string | undefined) {
  const [state, setState] = useState<GlobalSearchState>({
    mode: 'content',
    query: '',
    options: DEFAULT_OPTIONS,
    fileResults: [],
    contentResults: null,
    selectedIndex: 0,
    isLoading: false,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Keep refs to latest state values for use in debounced callbacks
  const stateRef = useRef(state);
  stateRef.current = state;

  const search = useCallback(
    async (query: string, mode: SearchMode, options: SearchOptions) => {
      if (!rootPath || !query.trim()) {
        setState((prev) => ({
          ...prev,
          fileResults: [],
          contentResults: null,
          selectedIndex: 0,
          isLoading: false,
        }));
        return;
      }

      // Cancel previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      setState((prev) => ({ ...prev, isLoading: true }));

      try {
        if (mode === 'files') {
          const results = await window.electronAPI.search.files({
            rootPath,
            query,
            maxResults: 100,
            useGitignore: options.useGitignore,
          });
          setState((prev) => ({
            ...prev,
            fileResults: results.items,
            contentResults: null,
            selectedIndex: 0,
            isLoading: false,
          }));
        } else {
          const results = await window.electronAPI.search.content({
            rootPath,
            query,
            maxResults: 500,
            caseSensitive: options.caseSensitive,
            wholeWord: options.wholeWord,
            regex: options.regex,
            filePattern: options.filePattern || undefined,
            useGitignore: options.useGitignore,
          });
          setState((prev) => ({
            ...prev,
            fileResults: [],
            contentResults: results,
            selectedIndex: 0,
            isLoading: false,
          }));
        }
      } catch {
        setState((prev) => ({ ...prev, isLoading: false }));
      }
    },
    [rootPath]
  );

  const setQuery = useCallback(
    (query: string) => {
      setState((prev) => ({ ...prev, query }));

      // Debounce search using stateRef to get latest mode/options
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        const { mode, options } = stateRef.current;
        search(query, mode, options);
      }, 300);
    },
    [search]
  );

  const setMode = useCallback(
    (mode: SearchMode) => {
      setState((prev) => ({ ...prev, mode, selectedIndex: 0 }));
      // Use stateRef to get latest query and options
      const { query, options } = stateRef.current;
      if (query.trim()) {
        search(query, mode, options);
      }
    },
    [search]
  );

  const setOptions = useCallback(
    (optionUpdates: Partial<SearchOptions>) => {
      const { query, mode, options } = stateRef.current;
      const newOptions = { ...options, ...optionUpdates };
      setState((prev) => ({ ...prev, options: newOptions }));
      // Trigger search with new options
      if (query.trim()) {
        search(query, mode, newOptions);
      }
    },
    [search]
  );

  const setSelectedIndex = useCallback((index: number) => {
    setState((prev) => ({ ...prev, selectedIndex: index }));
  }, []);

  const moveSelection = useCallback((delta: number) => {
    setState((prev) => {
      const maxIndex =
        prev.mode === 'files'
          ? prev.fileResults.length - 1
          : (prev.contentResults?.matches.length ?? 0) - 1;
      const newIndex = Math.max(0, Math.min(maxIndex, prev.selectedIndex + delta));
      return { ...prev, selectedIndex: newIndex };
    });
  }, []);

  const getSelectedItem = useCallback((): FileSearchResult | ContentSearchMatch | null => {
    if (state.mode === 'files') {
      return state.fileResults[state.selectedIndex] ?? null;
    }
    return state.contentResults?.matches[state.selectedIndex] ?? null;
  }, [state.mode, state.fileResults, state.contentResults, state.selectedIndex]);

  const reset = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setState({
      mode: 'content',
      query: '',
      options: DEFAULT_OPTIONS,
      fileResults: [],
      contentResults: null,
      selectedIndex: 0,
      isLoading: false,
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    ...state,
    setQuery,
    setMode,
    setOptions,
    setSelectedIndex,
    moveSelection,
    getSelectedItem,
    reset,
  };
}
