let latestSelectionText = '';

export function getEditorSelectionText(): string {
  return latestSelectionText;
}

export function setEditorSelectionText(selectionText: string): void {
  latestSelectionText = selectionText;
}
