import { StateEffect, StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

// Rendered-everywhere while the editor is not focused (like Scrapbox);
// only lines touched by the selection expand while it is. The selection
// popup is likewise only shown while focused.
const setFocus = StateEffect.define<boolean>();

export const focusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocus)) return e.value;
    return value;
  },
});

export const focusTracker = EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing));

export const isFocusEffect = (e: StateEffect<unknown>): boolean => e.is(setFocus);
