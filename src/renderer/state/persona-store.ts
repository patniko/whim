import type { AgentPersona } from '../../shared/ipc-contract';
import { reconcileByKey } from './reconcile';

export interface PersonaState {
  personas: AgentPersona[];
  hydrated: boolean;
}

type Listener = () => void;

/**
 * Minimal store for agent personas.
 *
 * The Settings panel (still in legacy app.ts) owns persona CRUD. Whenever it
 * loads or saves personas, it pushes the updated list into this store so the
 * React Agent list can render persona emojis reactively without depending on
 * a module-level `let personas` in app.ts.
 */
class PersonaStore {
  private state: PersonaState = {
    personas: [],
    hydrated: false,
  };
  private listeners: Set<Listener> = new Set();

  getState(): Readonly<PersonaState> {
    return this.state;
  }

  setPersonas(personas: AgentPersona[]): void {
    personas = reconcileByKey(this.state.personas, personas, persona => persona.id);
    if (personas === this.state.personas && this.state.hydrated) return;
    this.state = { ...this.state, personas, hydrated: true };
    this.notify();
  }

  reset(): void {
    this.state = { personas: [], hydrated: false };
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -- Derived state helpers --------------------------------------------------

  getByHandle(handle: string): AgentPersona | undefined {
    return this.state.personas.find(p => p.handle === handle);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const personaStore = new PersonaStore();
