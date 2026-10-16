/**
 * Copy to the clipboard, for the site's copy buttons (Build with Noised's commands, the official token's address):
 * the Clipboard API, else the older copy command; when both fail the button selects the text and says how to copy it.
 */

/**
 * Copies text to the clipboard: the Clipboard API, else the older copy command on a hidden field (some embedded
 * browsers). False when neither works.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (no permission, not a secure page): try the older way.
  }
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const field = document.createElement("textarea");
  try {
    field.value = text;
    field.setAttribute("readonly", "");
    field.setAttribute("aria-hidden", "true");
    for (const [k, v] of [
      ["position", "fixed"],
      ["top", "0"],
      ["left", "0"],
      ["opacity", "0"],
      ["pointer-events", "none"],
    ] as const)
      field.style.setProperty(k, v);
    document.body.append(field);
    field.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

export function selectContents(el: Element | null): void {
  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  if (!el || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function manualCopyHint(): string {
  if (typeof navigator === "undefined") return "Selected: copy it with Ctrl+C.";
  if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) return "Selected: tap Copy in the menu.";
  return /Mac|iPhone|iPad/.test(navigator.userAgent) ? "Selected: copy it with ⌘C." : "Selected: copy it with Ctrl+C.";
}
