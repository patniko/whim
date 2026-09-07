import type { CopilotSession, SessionEventType } from '@github/copilot-sdk';
import { getStorageGeneration, withStorageGeneration } from '../storage';
import { observeProducer } from '../producer-tasks';

type Listener = (event: any) => unknown;
export function observeSession(session: CopilotSession, typeOrListener: SessionEventType | Listener, listener?: Listener): () => void {
  const generation = getStorageGeneration();
  const handler = typeof typeOrListener === 'function' ? typeOrListener : listener;
  if (!handler) throw new Error('Missing session event listener');
  const wrapped = (event: any) => {
    try {
      const result = withStorageGeneration(generation, () => handler(event));
      if (result instanceof Promise) return observeProducer(result);
      return result;
    } catch (error) {
      console.error('[session] Event rejected:', error);
    }
  };
  return typeof typeOrListener === 'string' ? session.on(typeOrListener, wrapped) : session.on(wrapped);
}
