import type { CopilotSession } from "@github/copilot-sdk";
import type { PageRequest } from "../../shared/paging";
import {
  openRuntimeHistory,
  appendRuntimeHistory,
  queryRuntimeHistory,
  assertWorkspaceContext,
} from "../storage";

export interface HistorySession {
  sessionId: string;
  rpc: { eventLog: Pick<CopilotSession["rpc"]["eventLog"], "read"> };
}
const flights = new WeakMap<HistorySession, Promise<void>>();

export async function loadRuntimeHistoryPage(
  agentId: string,
  session: HistorySession,
  ephemeral: boolean,
  request: PageRequest = {},
) {
  let flight = flights.get(session);
  if (!flight) {
    flight = backfill(agentId, session, ephemeral);
    flights.set(session, flight);
    void flight
      .finally(() => {
        if (flights.get(session) === flight) flights.delete(session);
      })
      .catch(() => {
        /* the requesting callers receive the original rejection */
      });
  }
  await flight;
  assertWorkspaceContext();
  return queryRuntimeHistory(agentId, session.sessionId, request);
}

async function backfill(
  agentId: string,
  session: HistorySession,
  ephemeral: boolean,
): Promise<void> {
  let cursor = await openRuntimeHistory(agentId, session.sessionId, ephemeral);
  if (!session.rpc.eventLog?.read) {
    throw new Error(
      "This runtime does not support paged history. Update the runtime to view this conversation.",
    );
  }
  let more: boolean;
  do {
    const batch = await session.rpc.eventLog.read({
      cursor,
      max: 32,
      includeEphemeral: false,
      waitMs: 0,
    });
    assertWorkspaceContext();
    if (!batch.cursor || (batch.hasMore && batch.cursor === cursor))
      throw new Error("Runtime history cursor did not advance");
    if (batch.events.length > 32)
      throw new Error("Runtime history exceeded the requested batch size");
    const events = batch.events.map((event) => ({
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      payload: JSON.stringify(event.data),
    }));
    await appendRuntimeHistory(agentId, session.sessionId, events, batch.cursor);
    cursor = batch.cursor;
    more = batch.hasMore;
  } while (more);
}
