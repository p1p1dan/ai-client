import { useCallback, useEffect, useRef } from 'react';
import type { ResolvedAgent } from '@/components/todo/useEnabledAgents';
import { useAgentSessionsStore } from '@/stores/agentSessions';
import { INITIAL_AUTO_EXECUTE, useTodoStore } from '@/stores/todo';
import { buildAutoExecutePrompt, hasCompletedAutoExecuteOutput } from './autoExecuteMarker';

export { buildAutoExecutePrompt } from './autoExecuteMarker';

/**
 * Hook to manage auto-execute task completion detection
 *
 * Listens for agent stop events and:
 * 1. Marks current task as done
 * 2. Advances to next task in queue
 */
export function useAutoExecuteTask(
  repoPath: string,
  worktreePath: string | undefined,
  onSwitchToAgent?: () => void,
  enabledAgents?: ResolvedAgent[]
) {
  const autoExecute = useTodoStore((s) => s.autoExecute[repoPath] ?? INITIAL_AUTO_EXECUTE);
  const advanceQueue = useTodoStore((s) => s.advanceQueue);
  const stopAutoExecute = useTodoStore((s) => s.stopAutoExecute);
  const updateTask = useTodoStore((s) => s.updateTask);
  const setCurrentExecution = useTodoStore((s) => s.setCurrentExecution);

  // Use ref to break circular dependency between handleAgentStop and executeTask
  const executeTaskRef = useRef<(taskId: string) => void>(() => {});

  // Execute a single task
  const executeTask = useCallback(
    (taskId: string) => {
      if (!worktreePath || !enabledAgents || enabledAgents.length === 0) {
        stopAutoExecute(repoPath);
        return;
      }

      const tasks = useTodoStore.getState().tasks[repoPath] ?? [];
      const task = tasks.find((t) => t.id === taskId);
      if (!task) {
        // Task was deleted - skip to next in queue
        const nextTaskId = advanceQueue(repoPath);
        if (nextTaskId) {
          executeTaskRef.current(nextTaskId);
        } else {
          stopAutoExecute(repoPath);
        }
        return;
      }

      // Build prompt with auto-execute rules
      const taskContext = buildAutoExecutePrompt(task.title, task.description);

      const sessionId = crypto.randomUUID();

      // Create session via store action (handles displayOrder, activeIds, enhancedInputStates)
      useAgentSessionsStore.getState().addSession({
        id: sessionId,
        name: `Task: ${task.title}`,
        userRenamed: true,
        agentId: 'pi',
        initialized: false,
        repoPath,
        cwd: worktreePath,
        pendingCommand: taskContext,
      });

      // Update task status and link session
      updateTask(repoPath, taskId, { status: 'in-progress', sessionId });
      setCurrentExecution(repoPath, taskId, sessionId);

      onSwitchToAgent?.();
    },
    [
      repoPath,
      worktreePath,
      enabledAgents,
      updateTask,
      setCurrentExecution,
      onSwitchToAgent,
      stopAutoExecute,
      advanceQueue,
    ]
  );

  // Keep ref in sync to avoid circular dependency in handleAgentStop
  useEffect(() => {
    executeTaskRef.current = executeTask;
  }, [executeTask]);

  // Handle task completion based on stop notification
  const handleAgentStop = useCallback(
    (data: { sessionId: string; taskCompletionStatus: 'completed' | 'unknown' }) => {
      // Read latest state to avoid stale closure
      const currentAutoExecute =
        useTodoStore.getState().autoExecute[repoPath] ?? INITIAL_AUTO_EXECUTE;

      if (!worktreePath || !currentAutoExecute.running) return;

      if (data.sessionId !== currentAutoExecute.currentSessionId) return;

      const currentTaskId = currentAutoExecute.currentTaskId;
      if (!currentTaskId) return;

      if (data.taskCompletionStatus === 'completed') {
        // Completion marker detected - mark done and advance
        updateTask(repoPath, currentTaskId, { status: 'done', sessionId: undefined });
        const nextTaskId = advanceQueue(repoPath);
        if (nextTaskId && enabledAgents && enabledAgents.length > 0) {
          executeTaskRef.current(nextTaskId);
        } else {
          stopAutoExecute(repoPath);
        }
      } else {
        // No completion marker - revert task and stop
        updateTask(repoPath, currentTaskId, { status: 'todo', sessionId: undefined });
        stopAutoExecute(repoPath);
      }
    },
    [repoPath, worktreePath, updateTask, advanceQueue, stopAutoExecute, enabledAgents]
  );

  // Use ref for handler to avoid re-subscription on every callback change
  const handleAgentStopRef = useRef(handleAgentStop);
  useEffect(() => {
    handleAgentStopRef.current = handleAgentStop;
  }, [handleAgentStop]);

  // Start auto-execute with a list of tasks
  const startAutoExecute = useCallback(
    (taskIds: string[]) => {
      if (taskIds.length === 0 || !enabledAgents || enabledAgents.length === 0) {
        return;
      }

      const [firstTaskId, ...rest] = taskIds;

      // Queue only remaining tasks (exclude the first one being executed now)
      useTodoStore.getState().startAutoExecute(repoPath, rest);

      // Execute first task
      executeTask(firstTaskId);
    },
    [repoPath, enabledAgents, executeTask]
  );

  // Stop auto-execute
  const stop = useCallback(() => {
    stopAutoExecute(repoPath);
  }, [repoPath, stopAutoExecute]);

  // Reorder queue
  const reorderQueue = useCallback(
    (fromIndex: number, toIndex: number) => {
      useTodoStore.getState().reorderAutoExecuteQueue(repoPath, fromIndex, toIndex);
    },
    [repoPath]
  );

  // Remove from queue
  const removeFromQueue = useCallback(
    (taskId: string) => {
      useTodoStore.getState().removeFromAutoExecuteQueue(repoPath, taskId);
    },
    [repoPath]
  );

  // Pi TUI remains interactive after a response, so task completion is not a
  // process-exit signal. Detect the explicit auto-execute marker in its stream;
  // an exit before the marker is treated as an incomplete task.
  useEffect(() => {
    if (!autoExecute?.running) return;
    let output = '';
    let settled = false;
    const unsubscribeData = window.electronAPI.piTui.onData((event) => {
      const current = useTodoStore.getState().autoExecute[repoPath] ?? INITIAL_AUTO_EXECUTE;
      if (settled || event.terminalId !== current.currentSessionId) return;
      output = `${output}${event.data}`.slice(-1_048_576);
      // The TUI renders the submitted task prompt once, including the marker
      // instruction. Completion is the second exact marker emitted by Pi.
      if (!hasCompletedAutoExecuteOutput(output)) return;
      settled = true;
      handleAgentStopRef.current({
        sessionId: event.terminalId,
        taskCompletionStatus: 'completed',
      });
    });
    const unsubscribeExit = window.electronAPI.piTui.onExit((event) => {
      const current = useTodoStore.getState().autoExecute[repoPath] ?? INITIAL_AUTO_EXECUTE;
      if (settled || event.terminalId !== current.currentSessionId) return;
      settled = true;
      handleAgentStopRef.current({
        sessionId: event.terminalId,
        taskCompletionStatus: 'unknown',
      });
    });
    return () => {
      unsubscribeData();
      unsubscribeExit();
    };
  }, [autoExecute?.running, repoPath]);

  return {
    autoExecute,
    startAutoExecute,
    stop,
    reorderQueue,
    removeFromQueue,
    executeTask,
  };
}
