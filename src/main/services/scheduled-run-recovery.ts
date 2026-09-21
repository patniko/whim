import type { AgentSession } from '../../shared/types';

/** Persisted by stale-session reconciliation, including before scheduler startup. */
export const RESTART_INTERRUPTION_SUMMARY = 'Session lost \u2014 app restarted';

export function isRestartInterruptedSession(agent: AgentSession | null): boolean {
  return agent?.status === 'failed' && agent.source === 'sdk' && agent.run_location === 'local'
    && agent.summary === RESTART_INTERRUPTION_SUMMARY;
}
