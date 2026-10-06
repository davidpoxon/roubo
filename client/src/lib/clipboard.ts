/**
 * Writes text to the host clipboard from the renderer.
 *
 * Two paths, because a terminal clipboard write does not come from a user
 * gesture: an OSC 52 sequence arrives as asynchronous PTY output, and
 * `navigator.clipboard.writeText` rejects with "Document is not focused"
 * whenever the Roubo window is in the background, which is exactly when a
 * bench is most likely to be finishing the task the user asked it to copy
 * the result of. Electron's main process has no such restriction, so in the
 * desktop app the write goes over the preload bridge. The `navigator` path
 * stays for the client served to a plain browser at the same localhost URL,
 * where it is all there is, focused-only limitation included.
 *
 * Resolves `false` rather than rejecting. Every caller is either inside
 * xterm's write loop or a button press, and neither has anywhere to put a
 * rejection.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (text.length === 0) return false;
  try {
    const bridge = window.roubo?.writeClipboard;
    if (bridge) return await bridge(text);
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.warn("[roubo] clipboard write failed:", err);
    return false;
  }
}
