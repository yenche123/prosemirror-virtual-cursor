import type { ResolvedPos, Schema } from 'prosemirror-model';
import { Mark } from 'prosemirror-model';
import type { Selection } from 'prosemirror-state';
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Decoration, DecorationSet } from 'prosemirror-view';

export interface VirtualCursorOptions {
  /**
   * An array of ProseMirror mark names that should be ignored when checking the
   * [`inclusive`](https://prosemirror.net/docs/ref/#model.MarkSpec.inclusive)
   * attribute. You can also set this to `true` to skip the warning altogether.
   */
  skipWarning?: string[] | true;
}

export function createVirtualCursor(options?: VirtualCursorOptions): Plugin {
  const skipWarning = options?.skipWarning ?? false;

  let _cursor: HTMLElement | null =
    typeof document === 'undefined' ? null : document.createElement('div');

  return new Plugin({
    key,
    view: (view) => {
      if (skipWarning !== true) {
        checkInclusive(view.state.schema, skipWarning || []);
      }

      const doc = view.dom.ownerDocument;
      _cursor = _cursor || document.createElement('div');
      const cursor = _cursor;

      const update = () => {
        updateCursor(view, cursor);
      };

      let observer: ResizeObserver | undefined;
      if (window.ResizeObserver) {
        observer = new window.ResizeObserver(() => update());
        observer.observe(view.dom);
      }

      doc.addEventListener('selectionchange', update);

      return {
        update: () => {
          update();
        },
        destroy: () => {
          doc.removeEventListener('selectionchange', update);
          if (observer) {
            observer.unobserve(view.dom);
          }
        },
      };
    },
    props: {
      handleKeyDown: (view, event): boolean => {
        const { selection } = view.state;

        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.isComposing ||
          !['ArrowLeft', 'ArrowRight'].includes(event.key) ||
          !isTextSelection(selection) ||
          !selection.empty
        )
          return false;

        const $pos = selection.$head;
        const [marksBefore, marksAfter] = getMarksAround($pos);
        const marks = view.state.storedMarks || $pos.marks();

        // Don't move the cursor, only change the stored marks
        if (
          marksBefore &&
          marksAfter &&
          !Mark.sameSet(marksBefore, marksAfter)
        ) {
          if (event.key === 'ArrowLeft' && !Mark.sameSet(marksBefore, marks)) {
            view.dispatch(view.state.tr.setStoredMarks(marksBefore));
            return true;
          }

          if (event.key === 'ArrowRight' && !Mark.sameSet(marksAfter, marks)) {
            view.dispatch(view.state.tr.setStoredMarks(marksAfter));

            return true;
          }
        }

        // Move the cursor and also change the stored marks
        if (event.key === 'ArrowLeft' && $pos.textOffset === 1) {
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.create(view.state.doc, $pos.pos - 1))
              .setStoredMarks($pos.marks()),
          );
          return true;
        }
        if (
          event.key === 'ArrowRight' &&
          $pos.textOffset + 1 === $pos.parent.maybeChild($pos.index())?.nodeSize
        ) {
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.create(view.state.doc, $pos.pos + 1))
              .setStoredMarks($pos.marks()),
          );
          return true;
        }

        return false;
      },

      decorations: (state) => {
        if (
          !_cursor ||
          !isTextSelection(state.selection) ||
          !state.selection.empty
        )
          return;

        return DecorationSet.create(state.doc, [
          Decoration.widget(0, _cursor, {
            key: 'prosemirror-virtual-cursor',
          }),
        ]);
      },

      attributes: {
        class: 'virtual-cursor-enabled',
      },
    },
  });
}

const key = new PluginKey('prosemirror-virtual-cursor');

function getCursorRect(
  view: EditorView,
  toStart: boolean,
): { left: number; right: number; top: number; bottom: number } | null {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;

  const range = selection?.getRangeAt(0)?.cloneRange();
  if (!range) return null;

  range.collapse(toStart);
  const rect = range.getBoundingClientRect();

  if (rect.height) return rect;

  return view.coordsAtPos(view.state.selection.head);
}

function getMarksAround($pos: ResolvedPos) {
  const index = $pos.index();
  const after = $pos.parent.maybeChild(index);

  // When inside a text node, just return the text node's marks
  let before = $pos.textOffset ? after : null;

  if (!before && index > 0) before = $pos.parent.maybeChild(index - 1);

  return [before?.marks, after?.marks] as const;
}

function isTextSelection(selection: Selection): selection is TextSelection {
  return selection && typeof selection === 'object' && '$cursor' in selection;
}

function updateCursor(view?: EditorView, cursor?: HTMLElement) {
  if (!view || !view.dom || view.isDestroyed || !cursor) return;

  const { state, dom } = view;
  const { selection } = state;
  if (!isTextSelection(selection)) return;

  const cursorRect = getCursorRect(view, selection.$head === selection.$from);

  if (!cursorRect) return cursor;

  const editorRect = dom.getBoundingClientRect();

  let className = 'prosemirror-virtual-cursor';

  const $pos = state.selection.$head;
  const [marksBefore, marksAfter] = getMarksAround($pos);
  const marks = state.storedMarks || $pos.marks();

  if (
    selection.$cursor &&
    marksBefore &&
    marksAfter &&
    marks &&
    !Mark.sameSet(marksBefore, marksAfter)
  ) {
    if (Mark.sameSet(marksBefore, marks))
      className += ' prosemirror-virtual-cursor-left';
    else if (Mark.sameSet(marksAfter, marks))
      className += ' prosemirror-virtual-cursor-right';
  }

  cursor.className = className;
  restartAnimation(cursor, 'prosemirror-virtual-cursor-animation');
  cursor.style.height = `${cursorRect.bottom - cursorRect.top}px`;
  cursor.style.left = `${cursorRect.left - editorRect.left}px`;
  cursor.style.top = `${cursorRect.top - editorRect.top}px`;
}

// Restart CSS animation
// https://css-tricks.com/restart-css-animation/
function restartAnimation(element: HTMLElement, className: string) {
  // -> removing the class
  element.classList.remove(className);

  // -> triggering reflow /* The actual magic */
  // eslint-disable-next-line no-void
  void element.offsetWidth;

  // -> and re-adding the class
  element.classList.add(className);
}

function checkInclusive(schema: Schema, skipWarning: string[]) {
  for (const [mark, type] of Object.entries(schema.marks)) {
    if (type.spec.inclusive === false && !skipWarning.includes(mark)) {
      console.warn(
        `[prosemirror-virtual-cursor] Virtual cursor does not work well with marks that have inclusive set to false. Please consider removing the inclusive option from the "${mark}" mark or adding it to the "skipWarning" option.`,
      );
    }
  }
}
