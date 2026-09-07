import { closeHistory } from '@milkdown/kit/prose/history';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';

/** GFM stores checked state on the list item but does not render a checkbox. */
export function createListItemNodeView(node: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView {
  const dom = document.createElement('li');
  const task = node.attrs.checked != null;
  const contentDOM = task ? document.createElement('div') : dom;
  const checkbox = task ? document.createElement('input') : null;
  if (checkbox) {
    checkbox.type = 'checkbox';
    checkbox.contentEditable = 'false';
    checkbox.className = 'md-task-checkbox';
    contentDOM.className = 'md-task-content';
    dom.append(checkbox, contentDOM);
    checkbox.addEventListener('change', () => {
      const pos = getPos();
      if (pos === undefined || !view.editable) return;
      const current = view.state.doc.nodeAt(pos);
      if (current?.type.name !== 'list_item' || current.attrs.checked == null) return;
      view.dispatch(closeHistory(view.state.tr.setNodeMarkup(pos, undefined, {
        ...current.attrs,
        checked: checkbox.checked,
      })));
    });
  }

  const update = (next: ProseNode) => {
    if (next.type !== node.type || (next.attrs.checked != null) !== task) return false;
    dom.dataset.label = String(next.attrs.label);
    dom.dataset.listType = String(next.attrs.listType);
    dom.dataset.spread = String(next.attrs.spread);
    if (checkbox) {
      dom.dataset.itemType = 'task';
      dom.dataset.checked = String(next.attrs.checked);
      checkbox.checked = next.attrs.checked;
      checkbox.disabled = !view.editable;
      checkbox.setAttribute('aria-label', `${checkbox.checked ? 'Mark incomplete' : 'Mark complete'}: ${next.firstChild?.textContent || 'Task'}`);
    }
    return true;
  };
  update(node);
  return {
    dom,
    contentDOM,
    update,
    stopEvent: event => event.target === checkbox,
    ignoreMutation: mutation => mutation.type === 'attributes' && (mutation.target === dom || mutation.target === checkbox),
  };
}
