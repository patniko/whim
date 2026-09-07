import type { Skill } from '../../shared/types';
import { reconcileByKey } from './reconcile';

export interface SkillState {
  skills: Skill[];
  selectedSkillId: string | null;
}

type Listener = () => void;

class SkillStore {
  private state: SkillState = {
    skills: [],
    selectedSkillId: null,
  };
  private listeners: Set<Listener> = new Set();

  getState(): Readonly<SkillState> {
    return this.state;
  }

  setSkills(skills: Skill[]): void {
    skills = reconcileByKey(this.state.skills, skills, skill => skill.id);
    if (skills === this.state.skills) return;
    this.state = { ...this.state, skills };
    this.notify();
  }

  setSelectedSkill(id: string | null): void {
    this.state = { ...this.state, selectedSkillId: id };
    this.notify();
  }

  getSkill(id: string): Skill | undefined {
    return this.state.skills.find(s => s.id === id);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const skillStore = new SkillStore();
