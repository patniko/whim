import React from 'react';
import { skillStore } from '../state/skill-store';
import { useStore } from './useStore';
import { timeAgo } from './list-utils';
import { EmptyState } from './EmptyState';
import type { Skill } from '../../shared/types';

export interface SkillsListProps {
  /** Optional search filter applied client-side (matches legacy renderSkillsList). */
  filterQuery?: string;
  onSkillClick: (skillId: string) => void;
  onRunNow: (skillId: string) => void;
  onSchedule: (skillId: string) => void;
  onCreateSpace: (skillId: string) => void;
  onOpenFolder: (skillId: string) => void;
  onDelete: (skillId: string) => void;
}

function nextRunLabel(nextRunAt: string | null): string {
  if (!nextRunAt) return '';
  const due = new Date(nextRunAt);
  if (Number.isNaN(due.getTime())) return '';
  const diffMs = due.getTime() - Date.now();
  const overdue = diffMs < 0;
  const absMins = Math.floor(Math.abs(diffMs) / 60000);
  if (overdue) {
    if (absMins < 60) return `overdue ${absMins}m`;
    return 'overdue';
  }
  if (absMins < 60) return `in ${absMins}m`;
  const absHrs = Math.floor(absMins / 60);
  if (absHrs < 24) return `in ${absHrs}h`;
  return due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

const SkillRow = React.memo(function SkillRow({
  skill,
  onSkillClick,
  onRunNow,
  onSchedule,
  onCreateSpace,
  onOpenFolder,
  onDelete,
}: {
  skill: Skill;
  onSkillClick: (id: string) => void;
  onRunNow: (id: string) => void;
  onSchedule: (id: string) => void;
  onCreateSpace: (id: string) => void;
  onOpenFolder: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const scheduleText = skill.schedule ? `${skill.schedule}${skill.schedule_time ? ` ${skill.schedule_time}` : ''}` : '';
  const nextRun = nextRunLabel(skill.next_run_at);
  const lastRun = skill.last_run_at ? timeAgo(skill.last_run_at) : '';

  return (
    <div
      className="space-item skill-card"
      data-skill-id={skill.id}
      role="button"
      tabIndex={0}
      onClick={() => onSkillClick(skill.id)}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        // Don't intercept keystrokes on focused descendant buttons (their
        // own Enter/Space handlers should run instead of opening the card).
        if (target !== e.currentTarget && target.closest('button')) return;

        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onSkillClick(skill.id);
          return;
        }

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          // Stop propagation so the legacy global ArrowUp/Down handler in
          // app.ts (selectedIndex-based, scoped to Spaces) does not also fire.
          e.stopPropagation();

          const row = e.currentTarget as HTMLElement;
          const container = row.parentElement;
          if (!container) return;
          const items = Array.from(
            container.querySelectorAll<HTMLElement>('.space-item.skill-card'),
          );
          const idx = items.indexOf(row);
          if (idx === -1) return;

          if (e.key === 'ArrowDown') {
            const next = items[idx + 1];
            if (next) next.focus();
          } else {
            if (idx === 0) {
              const input = document.getElementById('description-input');
              if (input) (input as HTMLElement).focus();
            } else {
              items[idx - 1].focus();
            }
          }
        }
      }}
    >
      <div className="space-content">
        <div className="space-desc">
          <span className="skill-emoji">{skill.emoji || '🧩'}</span>{' '}
          {skill.name}
        </div>
        {skill.description ? <div className="skill-description">{skill.description}</div> : null}
        <div className="space-meta">
          {scheduleText ? <span className="skill-schedule">⏰ {scheduleText}</span> : null}
          {nextRun ? <span className="skill-next-run">next: {nextRun}</span> : null}
          {skill.canvas ? (
            <span className="skill-report" title="Publishes a report when it runs">
              📊 report
            </span>
          ) : null}
          {lastRun ? <span>last: {lastRun}</span> : null}
        </div>
      </div>
      <div className="skill-actions">
        <button
          type="button"
          className="skill-action"
          title="Run now"
          onClick={(e) => { e.stopPropagation(); onRunNow(skill.id); }}
        >
          ▶
        </button>
        <button
          type="button"
          className="skill-action"
          title="Schedule & report"
          onClick={(e) => { e.stopPropagation(); onSchedule(skill.id); }}
        >
          ⏰
        </button>
        <button
          type="button"
          className="skill-action"
          title="Create space"
          onClick={(e) => { e.stopPropagation(); onCreateSpace(skill.id); }}
        >
          ＋
        </button>
        <button
          type="button"
          className="skill-action"
          title="Open folder"
          onClick={(e) => { e.stopPropagation(); onOpenFolder(skill.id); }}
        >
          📁
        </button>
        <button
          type="button"
          className="space-delete"
          title="Delete skill"
          onClick={(e) => { e.stopPropagation(); onDelete(skill.id); }}
        >
          ✕
        </button>
      </div>
    </div>
  );
});

export function SkillsList(props: SkillsListProps): React.ReactElement {
  const { skills } = useStore(skillStore);

  const filtered = React.useMemo(() => {
    if (!props.filterQuery) return skills;
    const q = props.filterQuery.toLowerCase();
    return skills.filter(
      s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skills, props.filterQuery]);

  if (filtered.length === 0) {
    return props.filterQuery ? (
      <EmptyState icon="🔍" title="No matching skills" text="Try a different search." />
    ) : (
      <EmptyState
        icon="🧩"
        title="No skills yet"
        text="Skills are reusable prompts whim can run on demand or on a schedule."
        cta={{ label: 'Create a skill', onClick: () => (window as any).createNewSkill?.() }}
      />
    );
  }

  return (
    <>
      {filtered.map((skill) => (
        <SkillRow
          key={skill.id}
          skill={skill}
          onSkillClick={props.onSkillClick}
          onRunNow={props.onRunNow}
          onSchedule={props.onSchedule}
          onCreateSpace={props.onCreateSpace}
          onOpenFolder={props.onOpenFolder}
          onDelete={props.onDelete}
        />
      ))}
    </>
  );
}
