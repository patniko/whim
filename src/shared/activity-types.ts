export interface ActivityRow {
  key: string;
  kind: "space" | "event";
  spaceId: string | null;
  at: number;
  icon: string;
  variant: "dismissed" | "session" | "recurring" | "completed";
  title: string;
  client: string | null;
  agentCount: number;
  hasSession: boolean;
  duration: string;
  rescheduled: number;
}
