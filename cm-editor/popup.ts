// The popup shown next to a text selection (Scrapbox's "select text -> act
// on it"): link / decoration buttons and "ページ切り出し". A CodeMirror
// tooltip, so positioning, flipping at the viewport edge and following
// scroll are handled for us. It reuses the app's .selection-toolbar look.
import { StateField, type Extension } from '@codemirror/state';
import { showTooltip, type EditorView, type Tooltip } from '@codemirror/view';
import { focusField } from './focus';
import { FORMAT_ACTIONS, wrapSelection } from './format';

const coarsePointer = (): boolean => window.matchMedia('(pointer: coarse)').matches;

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'selection-toolbar-btn';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

export function selectionPopup(extract: (view: EditorView) => void): Extension {
  return StateField.define<Tooltip | null>({
    create: () => null,
    update(value, tr) {
      const sel = tr.state.selection.main;
      if (!tr.state.field(focusField) || tr.state.selection.ranges.length !== 1 || sel.empty) return null;
      if (!tr.state.sliceDoc(sel.from, sel.to).trim()) return null;
      // Unchanged selection (e.g. a focus-only transaction): keep the same
      // tooltip object so CodeMirror doesn't rebuild the DOM under the pointer.
      if (value && value.pos === (coarsePointer() ? sel.to : sel.from)) return value;
      const touch = coarsePointer();
      return {
        // On a phone the OS's own cut/copy callout sits above the selection;
        // put ours below it (at the selection's end) instead of fighting over the same spot.
        pos: touch ? sel.to : sel.from,
        above: !touch,
        strictSide: false,
        arrow: false,
        create(view) {
          const dom = document.createElement('div');
          dom.className = 'selection-toolbar sbe-popup';
          // A button press must not blur the editor (that would commit and
          // collapse the selection before the click lands). Not touchstart:
          // cancelling that would also cancel the click on iOS.
          dom.addEventListener('mousedown', (e) => e.preventDefault());
          for (const a of FORMAT_ACTIONS) dom.append(button(a.label, a.title, () => wrapSelection(view, a.open, a.close)));
          dom.append(button('ページ切り出し', '選択範囲を新しいページに切り出してリンクする', () => extract(view)));
          return { dom };
        },
      };
    },
    provide: (f) => showTooltip.from(f),
  });
}
