// Keeping the caret visible above the on-screen keyboard.
//
// On iOS the keyboard shrinks only the *visual* viewport, and the app's
// fixed footer (.bottombar, see trackKeyboardInset in app.ts) rides on top of
// the keyboard -- so the usable area for the caret is the visual viewport
// minus that footer. CodeMirror's own scrollIntoView (run on every edit)
// learns about the footer through scrollMargins; the keyboard opening after a
// tap is not a transaction at all, so that case is handled here by watching
// the visual viewport.
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

const MARGIN = 24;

function footerHeight(): number {
  return document.querySelector<HTMLElement>('.bottombar')?.offsetHeight ?? 0;
}

// Scrolls the *page* just enough that the caret line is inside the visible
// area. Exported for the viewport listener below.
export function revealCaret(view: EditorView): void {
  if (!view.hasFocus) return;
  const rect = view.coordsAtPos(view.state.selection.main.head);
  if (!rect) return;
  const vv = window.visualViewport;
  const viewTop = vv ? vv.offsetTop : 0;
  const viewBottom = viewTop + (vv ? vv.height : window.innerHeight) - footerHeight();
  if (rect.bottom + MARGIN > viewBottom) window.scrollBy(0, rect.bottom + MARGIN - viewBottom);
  else if (rect.top - MARGIN < viewTop) window.scrollBy(0, rect.top - MARGIN - viewTop);
}

// Re-checks whenever the visual viewport changes (keyboard shown/hidden or
// resized, pinch/scroll). Nothing calls EditorView.destroy() when app.ts
// re-renders the page, so the listeners retire themselves once the editor's
// DOM is gone.
const viewportWatcher = ViewPlugin.fromClass(
  class {
    private readonly vv = window.visualViewport;
    private readonly onChange = (): void => {
      if (!this.view.dom.isConnected) this.destroy();
      else revealCaret(this.view);
    };
    constructor(readonly view: EditorView) {
      this.vv?.addEventListener('resize', this.onChange);
      this.vv?.addEventListener('scroll', this.onChange);
    }
    destroy(): void {
      this.vv?.removeEventListener('resize', this.onChange);
      this.vv?.removeEventListener('scroll', this.onChange);
    }
  }
);

export const keyboardAware: Extension = [
  EditorView.scrollMargins.of(() => ({ top: MARGIN, bottom: footerHeight() + MARGIN })),
  EditorView.domEventHandlers({
    focus(_e, view) {
      // The keyboard animates in after focus; check right away and again once it has settled.
      requestAnimationFrame(() => revealCaret(view));
      setTimeout(() => revealCaret(view), 350);
    },
  }),
  viewportWatcher,
];
