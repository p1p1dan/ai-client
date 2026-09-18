import { useEffect } from 'react';
import {
  registerSignInConfirmHost,
  resolveSignInConfirmation,
  useSignInConfirmStore,
} from '@/stores/signInConfirm';
import { SignInConfirmDialog } from './SignInConfirmDialog';

/**
 * The single mount point for the sign-in confirmation.
 *
 * Mounted once in `App.tsx`, next to `UnsavedPromptHost` and for the same
 * reason: six callers need the same prompt and none of them is a good owner of
 * a dialog. Registering itself is what lets `requestSignInConfirmation` fail
 * loudly instead of hanging when nothing is mounted.
 */
export function SignInConfirmHost() {
  const { open, kind, snapshot } = useSignInConfirmStore();

  useEffect(() => registerSignInConfirmHost(), []);

  return (
    <SignInConfirmDialog
      open={open}
      kind={kind}
      snapshot={snapshot}
      onAnswer={(granted) => resolveSignInConfirmation(granted ? 'granted' : 'declined')}
    />
  );
}
