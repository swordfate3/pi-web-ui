/** Close a picker without allowing its outstanding listing to reopen it. */
export function cancelSavedSessionPicker(requests: { current: number }, close: () => void): void {
  requests.current++;
  close();
}
