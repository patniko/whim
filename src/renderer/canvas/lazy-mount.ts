import type * as Canvas from './mount';
import type * as Panel from './worker-panel-mount';

let canvas: typeof Canvas | undefined;
let panel: typeof Panel | undefined;
let loading: Promise<void> | undefined;

export function loadCanvasFeature(): Promise<void> {
  return loading ??= Promise.all([import('./mount'), import('./worker-panel-mount')])
    .then(([editor, workers]) => { canvas = editor; panel = workers; })
    .catch(error => {
      loading = undefined;
      window.dispatchEvent(new Event('whim:feature-load-failed'));
      throw error;
    });
}

function editor(): typeof Canvas {
  if (!canvas) throw new Error('Editor is not loaded');
  return canvas;
}

export const mountCanvas: typeof Canvas.mountCanvas = (...args) => editor().mountCanvas(...args);
export const unmountCanvas: typeof Canvas.unmountCanvas = async (...args) =>
  canvas ? canvas.unmountCanvas(...args) : { success: true };
export const saveCanvas: typeof Canvas.saveCanvas = async () =>
  canvas ? canvas.saveCanvas() : { success: true };
export const getCanvasContent: typeof Canvas.getCanvasContent = () => canvas?.getCanvasContent() ?? '';
export const getCanvasEditorMode: typeof Canvas.getCanvasEditorMode = () => canvas?.getCanvasEditorMode() ?? 'rendered';
export const getCanvasSelectedText: typeof Canvas.getCanvasSelectedText = () => canvas?.getCanvasSelectedText() ?? '';
export const toggleCanvasMode: typeof Canvas.toggleCanvasMode = () => editor().toggleCanvasMode();
export const replaceCanvasContent: typeof Canvas.replaceCanvasContent = (...args) => editor().replaceCanvasContent(...args);
export const appendCanvasLink: typeof Canvas.appendCanvasLink = (...args) => editor().appendCanvasLink(...args);
export const replaceCanvasText: typeof Canvas.replaceCanvasText = (...args) => editor().replaceCanvasText(...args);
export const focusCanvasEditor: typeof Canvas.focusCanvasEditor = () => canvas?.focusCanvasEditor();
export const updateCanvasPresence: typeof Canvas.updateCanvasPresence = (...args) => canvas?.updateCanvasPresence(...args);
export const updateCanvasAgentThreadStatuses: typeof Canvas.updateCanvasAgentThreadStatuses = (...args) => canvas?.updateCanvasAgentThreadStatuses(...args);
export const updateCanvasAgentInteractions: typeof Canvas.updateCanvasAgentInteractions = (...args) => canvas?.updateCanvasAgentInteractions(...args);
export const updateCanvasDecorations: typeof Canvas.updateCanvasDecorations = (...args) => canvas?.updateCanvasDecorations(...args);
export const updateCanvasAgentUsers: typeof Canvas.updateCanvasAgentUsers = (...args) => canvas?.updateCanvasAgentUsers(...args);
export const addCanvasCommentReply: typeof Canvas.addCanvasCommentReply = (...args) => editor().addCanvasCommentReply(...args);
export const updateCanvasFrontmatter: typeof Canvas.updateCanvasFrontmatter = (...args) => editor().updateCanvasFrontmatter(...args);
export const mountCanvasWorkerPanel: typeof Panel.mountCanvasWorkerPanel = (...args) => {
  if (!panel) throw new Error('Worker panel is not loaded');
  panel.mountCanvasWorkerPanel(...args);
};
export const unmountCanvasWorkerPanel: typeof Panel.unmountCanvasWorkerPanel = () => panel?.unmountCanvasWorkerPanel();
export const isCanvasChatPaneOpen: typeof Panel.isCanvasChatPaneOpen = () => panel?.isCanvasChatPaneOpen() ?? false;
export const closeCanvasChatPane: typeof Panel.closeCanvasChatPane = () => panel?.closeCanvasChatPane();
