interface WhimAgentRecord {
  agentId: string;
  sessionId: string;
  spaceId: string;
  status: 'running' | 'waiting-approval' | 'completed' | 'failed';
  summary: string;
  selectedText: string;
  yoloMode?: boolean;
  remote?: { enabled: boolean; remoteSteerable: boolean; url?: string };
  pendingApprovals: Map<string, { permissionKind: string | null; intention?: string; path?: string }>;
  pendingApprovalId: string | null;
  pendingPermissionKind: string | null;
}

export interface WhimToolContext {
  agentId: string;
  registry: {
    get(id: string): WhimAgentRecord | undefined;
    values(): IterableIterator<WhimAgentRecord>;
  };
  broker: {
    resolvePermission(agentId: string, requestId: string, approved: boolean): void;
  };
  getSpaces: () => Promise<Array<{
    id: string;
    description: string;
    body: string | null;
    status: string;
    folder: string | null;
  }>>;
  setYoloMode: (agentId: string, enabled: boolean) => Promise<{ ok: true } | { error: string }>;
  sendChatMessage: (agentId: string, prompt: string) => Promise<{ error?: string }>;
  getAgentHistory: (agentId: string) => Promise<{ events: any[]; restarted?: boolean } | { error: string }>;
}
