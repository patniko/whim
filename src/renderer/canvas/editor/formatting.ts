import { setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands';
import { closeHistory, redo, undo } from '@milkdown/kit/prose/history';
import type { Node, NodeRange } from '@milkdown/kit/prose/model';
import { liftListItem, sinkListItem, splitListItem, wrapRangeInList } from '@milkdown/kit/prose/schema-list';
import { AllSelection, EditorState, Selection, TextSelection, type Command } from '@milkdown/kit/prose/state';
import { liftTarget } from '@milkdown/kit/prose/transform';
import type { FormatMark } from './geometry';

export const TEXT_STYLES = [
  { value: 'paragraph', label: 'Normal text' },
  { value: 'h1', label: 'Heading 1' },
  { value: 'h2', label: 'Heading 2' },
  { value: 'h3', label: 'Heading 3' },
  { value: 'h4', label: 'Heading 4' },
  { value: 'h5', label: 'Heading 5' },
  { value: 'h6', label: 'Heading 6' },
  { value: 'code_block', label: 'Code block' },
] as const;

export type TextStyle = typeof TEXT_STYLES[number]['value'];
export type ListKind = 'bulletList' | 'orderedList' | 'taskList';
export type FormatAction = FormatMark | ListKind | 'blockquote' | 'indent' | 'outdent' | 'undo' | 'redo';

export interface FormattingState {
  textStyle: TextStyle | '';
  active: Partial<Record<FormatAction, boolean>>;
  enabled: Record<FormatAction, boolean>;
  styles: Record<TextStyle, boolean>;
  linkActive: boolean;
  linkEnabled: boolean;
}

const MARK_NAMES: Record<FormatMark, string> = {
  strong: 'strong',
  emphasis: 'emphasis',
  strikethrough: 'strike_through',
  inlineCode: 'inlineCode',
};

function isList(node: Node): boolean {
  return node.type.name === 'bullet_list' || node.type.name === 'ordered_list';
}

function contentSelection(state: EditorState): Selection {
  return state.selection instanceof AllSelection
    ? TextSelection.between(Selection.atStart(state.doc).$from, Selection.atEnd(state.doc).$to)
    : state.selection;
}

function listRange(state: EditorState): NodeRange | null {
  const { $from, $to } = contentSelection(state);
  return $from.blockRange($to, isList);
}

function listKind(range: NodeRange): ListKind | null {
  const items = [];
  for (let i = range.startIndex; i < range.endIndex; i++) items.push(range.parent.child(i));
  if (items.every(item => item.attrs.checked != null)) return 'taskList';
  if (items.some(item => item.attrs.checked != null)) return null;
  return range.parent.type.name === 'ordered_list' ? 'orderedList' : 'bulletList';
}

export function toggleList(kind: ListKind): Command {
  return (state, dispatch) => {
    if (state.selection instanceof AllSelection) {
      // List commands need a content range, not the document boundary from
      // Select All. Do not apply a synthetic transaction through live listeners.
      return toggleList(kind)(EditorState.create({
        schema: state.schema,
        doc: state.doc,
        selection: contentSelection(state),
        storedMarks: state.storedMarks,
      }), dispatch);
    }
    const itemType = state.schema.nodes.list_item;
    const type = state.schema.nodes[kind === 'orderedList' ? 'ordered_list' : 'bullet_list'];
    const existing = listRange(state);
    if (existing && listKind(existing) === kind) {
      return liftListItem(itemType)(state, dispatch);
    }

    const tr = state.tr;
    let range = existing;
    if (!range) {
      // Lists require paragraphs as their first child, including when starting
      // from a heading or code block. Keep this conversion in the same undo step.
      tr.setBlockType(tr.selection.from, tr.selection.to, state.schema.nodes.paragraph);
      const blocks = tr.selection.$from.blockRange(tr.selection.$to);
      if (!blocks || !wrapRangeInList(tr, blocks, type)) return false;
      range = tr.selection.$from.blockRange(tr.selection.$to, isList);
    }
    if (!range) return false;

    const pos = range.$from.before(range.depth);
    const list = tr.doc.nodeAt(pos)!;
    tr.setNodeMarkup(pos, type, { ...list.attrs, order: list.attrs.order ?? 1 });
    list.forEach((item, offset) => {
      tr.setNodeMarkup(pos + 1 + offset, undefined, {
        ...item.attrs,
        checked: kind === 'taskList' ? (item.attrs.checked ?? false) : null,
        listType: kind === 'orderedList' ? 'ordered' : 'bullet',
      });
    });
    dispatch?.(closeHistory(tr).scrollIntoView());
    return true;
  };
}

export function setTextStyle(style: TextStyle): Command {
  return (state, dispatch) => {
    const heading = style.startsWith('h');
    return setBlockType(
      state.schema.nodes[heading ? 'heading' : style],
      heading ? { level: Number(style.slice(1)) } : undefined,
    )(state, dispatch);
  };
}

export function markActive(state: EditorState, mark: FormatMark): boolean {
  const type = state.schema.marks[MARK_NAMES[mark]];
  const { from, to, empty, $from } = state.selection;
  return empty
    ? !!type.isInSet(state.storedMarks ?? $from.marks())
    : state.doc.rangeHasMark(from, to, type);
}

function inlineCode(): Command {
  return (state, dispatch) => {
    const type = state.schema.marks.inlineCode;
    if (!toggleMark(type)(state)) return false;
    const { from, to, empty } = state.selection;
    const tr = state.tr;
    if (markActive(state, 'inlineCode')) {
      if (empty) tr.removeStoredMark(type);
      else tr.removeMark(from, to, type);
    } else if (empty) {
      tr.setStoredMarks([type.create()]);
    } else {
      tr.removeMark(from, to).addMark(from, to, type.create());
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

export function formatCommand(action: FormatAction): Command {
  switch (action) {
    case 'undo': return undo;
    case 'redo': return redo;
    case 'bulletList':
    case 'orderedList':
    case 'taskList': return toggleList(action);
    case 'indent': return (state, dispatch) => sinkListItem(state.schema.nodes.list_item)(state, dispatch);
    case 'outdent': return (state, dispatch) => liftListItem(state.schema.nodes.list_item)(state, dispatch);
    case 'blockquote':
      return (state, dispatch) => {
        const { $from, $to } = contentSelection(state);
        const range = $from.blockRange($to, node => node.type.name === 'blockquote');
        if (!range) return wrapIn(state.schema.nodes.blockquote)(state, dispatch);
        const target = liftTarget(range);
        if (target === null) return false;
        dispatch?.(state.tr.lift(range, target).scrollIntoView());
        return true;
      };
    case 'inlineCode': return inlineCode();
    default: return (state, dispatch) => toggleMark(state.schema.marks[MARK_NAMES[action]])(state, dispatch);
  }
}

/** Enter continues a checklist with an unchecked item, even after a checked item. */
export const splitTaskItem: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.depth < 2 || $from.node(-1).type.name !== 'list_item' || $from.node(-1).attrs.checked == null) return false;
  return splitListItem(state.schema.nodes.list_item, { ...$from.node(-1).attrs, checked: false })(state, dispatch && (tr => {
    const item = tr.selection.$from.node(-1);
    if (item.type.name === 'list_item') {
      tr.setNodeMarkup(tr.selection.$from.before(-1), undefined, { ...item.attrs, checked: false });
    }
    dispatch(tr);
  }));
};

export function canLink(state: EditorState): boolean {
  const { selection, schema, doc } = state;
  if (!(selection instanceof TextSelection) && !(selection instanceof AllSelection)) return false;
  if (selection.empty) {
    return selection.$from.parent.type.allowsMarkType(schema.marks.link) && !markActive(state, 'inlineCode');
  }
  let text = false;
  let code = false;
  doc.nodesBetween(selection.from, selection.to, node => {
    if (node.type.spec.code || node.marks.some(mark => mark.type.spec.code)) code = true;
    if (node.isText) text = true;
  });
  return text && !code;
}

function nodeTextStyle(node: Node): TextStyle | '' {
  if (node.type.name === 'heading') {
    return TEXT_STYLES.find(style => style.value === `h${node.attrs.level}`)?.value ?? '';
  }
  return TEXT_STYLES.find(style => style.value === node.type.name)?.value ?? '';
}

export function getFormattingState(state: EditorState): FormattingState {
  const range = listRange(state);
  const activeList = range ? listKind(range) : null;
  const { $from: start, $to: end } = contentSelection(state);
  const quote = !!start.blockRange(end, node => node.type.name === 'blockquote');
  const actions: FormatAction[] = ['strong', 'emphasis', 'strikethrough', 'inlineCode', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'indent', 'outdent', 'undo', 'redo'];
  const enabled = {} as Record<FormatAction, boolean>;
  for (const action of actions) enabled[action] = formatCommand(action)(state);
  const styles = {} as Record<TextStyle, boolean>;
  let textStyle = nodeTextStyle(contentSelection(state).$from.parent);
  state.doc.nodesBetween(state.selection.from, state.selection.to, node => {
    if (node.isTextblock && nodeTextStyle(node) !== textStyle) textStyle = '';
  });
  for (const style of TEXT_STYLES) styles[style.value] = style.value === textStyle || setTextStyle(style.value)(state);
  const { from, to, empty, $from } = state.selection;
  return {
    textStyle,
    active: {
      strong: markActive(state, 'strong'),
      emphasis: markActive(state, 'emphasis'),
      strikethrough: markActive(state, 'strikethrough'),
      inlineCode: markActive(state, 'inlineCode'),
      bulletList: activeList === 'bulletList',
      orderedList: activeList === 'orderedList',
      taskList: activeList === 'taskList',
      blockquote: quote,
    },
    enabled,
    styles,
    linkActive: empty
      ? !!state.schema.marks.link.isInSet(state.storedMarks ?? $from.marks())
      : state.doc.rangeHasMark(from, to, state.schema.marks.link),
    linkEnabled: canLink(state),
  };
}
