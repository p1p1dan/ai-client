export type PresentationMode = 'gui' | 'tui';

export const PRESENTATION_MODE_MIRROR_KEY = 'aiclient-presentation-mode';
export const DEFAULT_PRESENTATION_MODE: PresentationMode = 'gui';

export function parsePresentationMode(raw: unknown): PresentationMode {
  return raw === 'tui' ? 'tui' : 'gui';
}

export function readPresentationMode(): PresentationMode {
  try {
    return parsePresentationMode(localStorage.getItem(PRESENTATION_MODE_MIRROR_KEY));
  } catch {
    return DEFAULT_PRESENTATION_MODE;
  }
}

export function writePresentationMode(mode: PresentationMode): void {
  try {
    localStorage.setItem(PRESENTATION_MODE_MIRROR_KEY, mode);
  } catch {
    // The settings store remains authoritative when localStorage is unavailable.
  }
}
