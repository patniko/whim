import type * as Chat from './mount';

let chat: typeof Chat | undefined;
let loading: Promise<void> | undefined;

export function loadChatFeature(): Promise<void> {
  return loading ??= import('./mount').then(module => { chat = module; })
    .catch(error => { loading = undefined; throw error; });
}

export const mountChat: typeof Chat.mountChat = (...args) => {
  if (!chat) throw new Error('Chat is not loaded');
  chat.mountChat(...args);
};
export const unmountChat: typeof Chat.unmountChat = () => chat?.unmountChat();
