/**
 * Who may change a conversation right now (plugin-system README §4).
 *
 * The desktop by default; a plugin's client (the remote web page, say) once it
 * takes the conversation over. Whoever is not the controller still sees every
 * event, but its changes are refused until it takes the conversation back.
 */
export type SessionController =
  | { kind: 'desktop' }
  | {
      kind: 'client';
      /** The owner id the client's calls run under (negative, `allocateRemoteOwnerId`). */
      ownerId: number;
      pluginId: string;
      /** Shown to people: 「正在 {label} 上使用」. */
      label: string;
    };

export interface SessionControlChange {
  sessionId: string;
  controller: SessionController;
}
