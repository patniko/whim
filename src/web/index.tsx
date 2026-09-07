import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DocumentSave } from './lib/document-save';
import { createRoot } from 'react-dom/client';
import { FeatureBoundary } from '../renderer/FeatureBoundary';
const Markdown = lazy(() => import('./markdown'));
import type { AgentListAllItem, AgentPersona, GitSyncStatus } from '../shared/ipc-contract';
import type { SpaceSummary as Space, SpacePage, AgentPage, ActivityPage } from '../shared/paging';
import { PageControls } from '../renderer/views/PageControls';
import { VirtualRows } from '../renderer/views/VirtualRows';
import type { ChatEvent, ApprovalMessage } from '../shared/chat-types';
import { endSession, establishSession, hasSession, WebRemoteClient } from './lib/client';
import type { WebRemoteEvent } from '../main/web/event-hub';
import { agentGlyph, describeApproval, formatDueDate, humanizeToolName, statusLabel, timeAgo } from './lib/format';
import { applyInteractionEvent, type InteractionMap, type PendingInteraction } from './lib/interactions';
import { notificationState, notifyForEvent, registerServiceWorker, requestNotificationPermission, type NotificationPermissionState } from './lib/notifications';
import { applyChatEvent, applyChatEvents, parseHistory, historyBubbles, type Bubble } from './lib/transcript';
import { createEventBatch } from '../renderer/chat/event-batch';
import { acknowledgeUserMessage, mergeHistoryWithLocal, orderTranscript } from '../shared/chat-identity';
import { RefreshCoordinator } from '../renderer/state/refresh-coordinator';
import { observeRendererTasks, startTiming, getPerformanceTimings } from '../renderer/performance';

observeRendererTasks();
Object.defineProperty(window, '__whimPerformance', { value: getPerformanceTimings });
const finishShell = startTiming('startup.shell');
const finishCapture = startTiming('startup.capture');

type Tab = 'spaces' | 'workers' | 'history';

interface HistoryCommit {
  sha: string;
  shortSha?: string;
  message: string;
  date: string;
  relativeDate?: string;
}

// ── Root + auth ────────────────────────────────────────────

/**
 * The token is a one-time bootstrap credential only. It is exchanged for an
 * HttpOnly session cookie and then dropped from the URL, so it never lands in
 * browser history, a `Referer` header, or localStorage.
 */
function App() {
  useEffect(() => { finishShell(); }, []);
  const [authState, setAuthState] = useState<'checking' | 'authed' | 'unauthed' | 'offline'>('checking');
  const [authError, setAuthError] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setAuthState('checking');
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');

    (async () => {
      if (urlToken) {
        window.history.replaceState({}, '', window.location.pathname);
        try {
          await establishSession(urlToken);
          if (!cancelled) setAuthState('authed');
          return;
        } catch (err: any) {
          if (!cancelled) setAuthError(err?.message || 'Sign-in failed.');
        }
      }
      const ok = await hasSession();
      if (!cancelled) setAuthState(ok ? 'authed' : 'unauthed');
    })().catch(error => {
      if (!cancelled) {
        setAuthError(error instanceof Error ? error.message : 'Connection failed.');
        setAuthState('offline');
      }
    });

    return () => { cancelled = true; };
  }, [connectionAttempt]);

  useEffect(() => {
    const reconnect = () => setConnectionAttempt(attempt => attempt + 1);
    window.addEventListener('online', reconnect);
    return () => window.removeEventListener('online', reconnect);
  }, []);

  if (authState === 'offline') {
    return <main className="login">
      <div className="brand">whim</div>
      <h1>Cannot reach Whim</h1>
      <p>Reconnect to the desktop app, then retry. Your device pairing has not been removed.</p>
      <p className="login-error" role="alert">{authError}</p>
      <button type="button" onClick={() => setConnectionAttempt(attempt => attempt + 1)}>Retry connection</button>
    </main>;
  }

  if (authState === 'checking') {
    return <main className="login"><div className="brand">whim</div><p>Connecting…</p></main>;
  }

  if (authState === 'unauthed') {
    return (
      <Login
        error={authError}
        onLogin={async (token) => {
          await establishSession(token);
          setAuthError(null);
          setAuthState('authed');
        }}
      />
    );
  }

  return (
    <RemoteApp
      onLogout={async () => {
        await endSession();
        setAuthState('unauthed');
      }}
      onUnauthorized={() => {
        setAuthError('Your session is no longer valid. Enter the token from Settings to reconnect.');
        setAuthState('unauthed');
      }}
    />
  );
}

function Login({ onLogin, error }: { onLogin: (token: string) => Promise<void>; error: string | null }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(error);

  return (
    <main className="login">
      <div className="brand">whim</div>
      <h1>Remote access</h1>
      <p>Enter the token from the desktop app's settings, or scan the QR code from your phone.</p>
      {failure && <p className="login-error">{failure}</p>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!value.trim() || busy) return;
          setBusy(true);
          setFailure(null);
          try {
            await onLogin(value.trim());
          } catch (err: any) {
            setFailure(err?.message || 'Sign-in failed.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Token" autoFocus />
        <button type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
      </form>
    </main>
  );
}

// ── Main app ───────────────────────────────────────────────

function RemoteApp({ onLogout, onUnauthorized }: { onLogout: () => void; onUnauthorized: () => void }) {
  useEffect(() => { finishCapture(); }, []);
  const client = useMemo(() => new WebRemoteClient(), []);
  const [tab, setTab] = useState<Tab>('spaces');
  const [spacePage, setSpacePage] = useState<SpacePage>({ items: [], total: 0, nextCursor: null, counts: { open: 0, closed: 0 } });
  const [agentPage, setAgentPage] = useState<AgentPage>({ items: [], total: 0, nextCursor: null, counts: { running: 0, waiting: 0, completed: 0, failed: 0 } });
  const spaces = spacePage.items;
  const agents = agentPage.items;
  const [activityPage, setActivityPage] = useState<ActivityPage>({ items: [], total: 0, nextCursor: null });
  const [personas, setPersonas] = useState<AgentPersona[]>([]);
  const [git, setGit] = useState<GitSyncStatus | null>(null);
  // Questions an agent is blocked on that aren't carried by `agent:list-all`.
  const [interactions, setInteractions] = useState<InteractionMap>({});
  const [notifications, setNotifications] = useState<NotificationPermissionState>(() => notificationState());
  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState<string | null>(null);
  const [workspaceChanged, setWorkspaceChanged] = useState(false);
  const workspaceBlocked = useRef(false);

  const [openSpaceId, setOpenSpaceId] = useState<string | null>(null);
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);

  // Live chat events are buffered per-agent so an open chat picks them up.
  const liveChat = useRef<{ agentId: string; cb: (e: ChatEvent) => void } | null>(null);

  const positions = useRef<{ spaces?: string; agents?: string; history?: string }>({});
  const refreshes = useRef(new RefreshCoordinator(() => true));
  const loadSpacePage = useCallback(async (cursor?: string) => {
    positions.current.spaces = cursor;
    refreshes.current.invalidate('spaces');
    await refreshes.current.request('spaces', async isCurrent => {
      const page = await client.invoke('space:list-page', { cursor, filter: 'open' });
      if (isCurrent()) setSpacePage(page);
    }, true);
  }, [client]);
  const loadAgentPage = useCallback(async (cursor?: string) => {
    positions.current.agents = cursor;
    refreshes.current.invalidate('agents');
    await refreshes.current.request('agents', async isCurrent => {
      const page = await client.invoke('agent:list-page', { cursor });
      if (isCurrent()) setAgentPage(page);
    }, true);
  }, [client]);
  const loadActivityPage = useCallback(async (cursor?: string) => {
    positions.current.history = cursor;
    refreshes.current.invalidate('history');
    await refreshes.current.request('history', async isCurrent => {
      const now = new Date();
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).toISOString();
      const page = await client.invoke('activity:list-page', { cursor, dayStart, weekStart });
      if (isCurrent()) setActivityPage(page);
    }, true);
  }, [client]);
  const refreshSpaces = useCallback(() => loadSpacePage(positions.current.spaces), [loadSpacePage]);
  const refreshAgents = useCallback(() => loadAgentPage(positions.current.agents), [loadAgentPage]);
  const refreshEvents = useCallback(() => loadActivityPage(positions.current.history), [loadActivityPage]);
  const refreshGit = useCallback(async () => {
    try { setGit(await client.invoke('workspace:git-status')); } catch { /* non-fatal */ }
  }, [client]);

  const refreshAll = useCallback(async () => {
    if (workspaceBlocked.current) return;
    try {
      setError(null);
      const [, , pe] = await Promise.all([
        refreshSpaces(),
        refreshAgents(),
        client.invoke('personas:list'),
        refreshEvents(),
        refreshGit(),
      ]);
      setPersonas(pe);
    } catch (err: any) {
      setError(err?.message || 'Failed to load remote data');
    }
  }, [client, refreshSpaces, refreshAgents, refreshEvents, refreshGit]);

  useEffect(() => {
    void refreshAll();
    // A resync is requested whenever the server could not replay the events we
    // missed, so the UI never silently keeps rendering stale state.
    const disconnect = client.connect(
      (event) => handleEvent(event),
      setStatus,
      onUnauthorized,
      () => { void refreshAll(); },
    );
    return () => { refreshes.current.reset(); disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Coming back from a backgrounded tab is the most common way to end up
  // looking at stale data on a phone.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshAll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshAll]);

  function handleEvent(event: WebRemoteEvent) {
    if (workspaceBlocked.current) return;
    const ch = event.channel;
    if (ch === 'workspace:changed') {
      workspaceBlocked.current = true;
      setWorkspaceChanged(true);
      refreshes.current.reset();
      return;
    }
    if (ch === 'chat:event') {
      const payload = event.payload as { agentId?: string } & ChatEvent;
      if (liveChat.current && payload.agentId === liveChat.current.agentId) {
        liveChat.current.cb(payload as ChatEvent);
      }
      if (payload.type === 'session.idle' || payload.type === 'session.error') refreshAfterEvent(refreshAgents(), refreshEvents());
      return;
    }
    if (ch.startsWith('agent:')) {
      setInteractions((prev) => applyInteractionEvent(prev, ch, event.payload));
      notifyForEvent(ch, event.payload);
    }
    if (ch === 'workspace:git-sync-changed') { setGit(event.payload as GitSyncStatus); return; }
    if (ch === 'workspace:committed') { void refreshAll(); return; }
    if (ch === 'canvas:content-updated') { window.dispatchEvent(new CustomEvent('whim:canvas-updated', { detail: event.payload })); return; }
    if (ch.startsWith('agent:')) { refreshAfterEvent(refreshAgents(), refreshEvents()); return; }
    if (ch.startsWith('space:')) { refreshAfterEvent(refreshSpaces(), refreshEvents()); return; }
  }

  function refreshAfterEvent(...updates: Promise<void>[]): void {
    void Promise.all(updates).catch(error => setError(error instanceof Error ? error.message : 'Could not refresh remote data'));
  }

  const [openSpace, setOpenSpace] = useState<Space | null>(null);
  const [openAgent, setOpenAgent] = useState<AgentListAllItem | null>(null);
  useEffect(() => {
    let active = true;
    if (!openSpaceId) { setOpenSpace(null); return; }
    void client.invoke('space:get', openSpaceId).then(value => { if (active) setOpenSpace(value); })
      .catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [client, openSpaceId]);
  useEffect(() => {
    let active = true;
    if (!openAgentId) { setOpenAgent(null); return; }
    void client.invoke('agent:get', openAgentId).then(value => { if (active) setOpenAgent(value); })
      .catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [client, openAgentId, agents]);

  return (
    <div className="app">
      <Topbar
        status={status}
        git={git}
        client={client}
        notifications={notifications}
        onEnableNotifications={() => { void requestNotificationPermission().then(setNotifications); }}
        onSync={refreshGit}
        onLogout={onLogout}
      />

      {error && <div className="banner">{error}</div>}
      {workspaceChanged && <div className="banner workspace-changed" role="alert">
        The desktop workspace changed. Copy any unsaved drafts before reloading.{' '}
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </div>}

      <nav className="tabs" aria-label="Sections">
        {(['spaces', 'workers', 'history'] as Tab[]).map((name) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>
            {name === 'spaces' ? 'Spaces' : name === 'workers' ? 'Workers' : 'History'}
          </button>
        ))}
      </nav>

      <main className="view">
        {tab === 'spaces' && (
          <SpacesView
            client={client}
            spaces={spaces}
            page={spacePage}
            onPage={loadSpacePage}
            agents={agents}
            onRefresh={refreshSpaces}
            onOpenSpace={(id) => setOpenSpaceId(id)}
            onOpenAgent={(id) => setOpenAgentId(id)}
          />
        )}
        {tab === 'workers' && (
          <WorkersView
            client={client}
            agents={agents}
            personas={personas}
            page={agentPage}
            onPage={loadAgentPage}
            onRefresh={refreshAgents}
            onOpenAgent={(id) => setOpenAgentId(id)}
          />
        )}
        {tab === 'history' && (
          <HistoryView client={client} page={activityPage} onPage={loadActivityPage} onRefresh={async () => { await refreshSpaces(); await refreshEvents(); }} onOpenSpace={(id) => setOpenSpaceId(id)} />
        )}
      </main>

      {openSpace && openSpace.id === openSpaceId && (
        <CanvasScreen
          key={openSpace.id}
          client={client}
          space={openSpace}
          agentUpdates={agents}
          personas={personas}
          onClose={() => setOpenSpaceId(null)}
          onOpenAgent={(id) => setOpenAgentId(id)}
          onRefreshAgents={refreshAgents}
        />
      )}

      {openAgent && openAgent.agentId === openAgentId && (
        <ChatScreen
          key={openAgent.agentId}
          client={client}
          agent={openAgent}
          interactions={interactions[openAgent.agentId] ?? []}
          registerLive={(agentId, cb) => { liveChat.current = { agentId, cb }; }}
          unregisterLive={() => { liveChat.current = null; }}
          onClose={() => setOpenAgentId(null)}
          onRefreshAgents={refreshAgents}
        />
      )}
    </div>
  );
}

// ── Topbar + git sync ──────────────────────────────────────

function Topbar({ status, git, client, notifications, onEnableNotifications, onSync, onLogout }: {
  status: string;
  git: GitSyncStatus | null;
  client: WebRemoteClient;
  notifications: NotificationPermissionState;
  onEnableNotifications: () => void;
  onSync: () => Promise<void>;
  onLogout: () => void;
}) {
  const [busy, setBusy] = useState<'push' | 'pull' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const live = status === 'live';

  async function run(kind: 'push' | 'pull') {
    setBusy(kind);
    setMsg(null);
    try {
      const result = await client.invoke(kind === 'push' ? 'workspace:git-push' : 'workspace:git-pull');
      if (result && 'error' in result && result.error) setMsg(result.error);
      await onSync();
    } catch (err: any) {
      setMsg(err?.message || 'Sync failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="brand">whim</span>
        <span className={`conn ${live ? 'live' : ''}`}><span className="conn-dot" />{status}</span>
      </div>
      <div className="topbar-right">
        {git && git.available && (
          <div className="git">
            <span className="git-branch" title="Current branch">⎇ {git.branch || 'detached'}</span>
            {git.behind > 0 && (
              <button className="git-btn" disabled={busy !== null} onClick={() => run('pull')} title="Pull from origin">
                ↓ {git.behind}
              </button>
            )}
            {git.ahead > 0 && (
              <button className="git-btn" disabled={busy !== null} onClick={() => run('push')} title="Push to origin">
                ↑ {git.ahead}
              </button>
            )}
            {git.ahead === 0 && git.behind === 0 && <span className="git-synced" title="Up to date">✓ synced</span>}
          </div>
        )}
        {notifications === 'default' && (
          <button className="ghost icon-btn" onClick={onEnableNotifications} title="Enable alerts for approvals and questions">🔔</button>
        )}
        <button className="ghost icon-btn" onClick={onLogout} title="Log out">⎋</button>
      </div>
      {msg && <div className="topbar-msg">{msg}</div>}
    </header>
  );
}

// ── Spaces ─────────────────────────────────────────────────

function SpacesView({ client, spaces, agents, page, onPage, onRefresh, onOpenSpace, onOpenAgent }: {
  client: WebRemoteClient;
  spaces: Space[];
  page: SpacePage;
  onPage: (cursor?: string) => Promise<void>;
  agents: AgentListAllItem[];
  onRefresh: () => Promise<void>;
  onOpenSpace: (id: string) => void;
  onOpenAgent: (id: string) => void;
}) {
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Space[] | null>(null);
  const [searchPage, setSearchPage] = useState<SpacePage | null>(null);
  const [searchError, setSearchError] = useState('');
  const searchRevision = useRef(0);

  const agentsBySpace = useMemo(() => {
    const m = new Map<string, AgentListAllItem[]>();
    for (const a of agents) {
      if (!a.spaceId) continue;
      const list = m.get(a.spaceId) || [];
      list.push(a);
      m.set(a.spaceId, list);
    }
    return m;
  }, [agents]);

  const list = (results ?? spaces).filter((s) => results ? true : s.status !== 'done');

  async function capture(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setSaving(true);
    try {
      await client.invoke('space:create', { body: text });
      setBody('');
      await onRefresh();
    } finally {
      setSaving(false);
    }
  }

  async function search(next: string, cursor?: string) {
    const revision = ++searchRevision.current;
    setQuery(next);
    if (!next.trim()) { setResults(null); setSearchPage(null); return; }
    setSearchError('');
    try {
      const page = await client.invoke('space:list-page', { query: next, cursor, filter: 'all' });
      if (revision !== searchRevision.current) return;
      setResults(page.items);
      setSearchPage(page);
    } catch (failure) {
      if (revision === searchRevision.current) setSearchError(String(failure));
      throw failure;
    }
  }

  async function toggleDone(space: Space) {
    await client.invoke('space:update', space.id, { status: space.status === 'done' ? 'captured' : 'done' });
    await onRefresh();
  }

  async function remove(space: Space) {
    if (!confirm('Delete this space?')) return;
    await client.invoke('space:delete', space.id);
    await onRefresh();
  }

  return (
    <div className="stack">
      <form className="capture" onSubmit={capture}>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="What needs to get done?" rows={3} />
        <button disabled={saving || !body.trim()}>{saving ? 'Capturing…' : 'Capture'}</button>
      </form>

      <input className="search" value={query} onChange={(e) => { void search(e.target.value).catch(error => console.error('[search]', error)); }} placeholder="Search spaces" />
      {searchError && <p role="alert">{searchError}</p>}
      <PageControls nextCursor={(searchPage ?? page).nextCursor} total={(searchPage ?? page).total}
        count={list.length} scope={query} load={cursor => query ? search(query, cursor) : onPage(cursor)} />

      {list.length === 0 && <Empty icon="🎯" title={results ? 'No matching spaces' : 'No spaces yet'} detail={results ? 'Try another search.' : 'Capture an intent above to get started.'} />}

      <div className="space-list">
        <VirtualRows rows={list} rowId={space => space.id} total={(searchPage ?? page).total} offset={(searchPage ?? page).offset} render={space => (
          <SpaceRow
            key={space.id}
            space={space}
            agents={agentsBySpace.get(space.id) || []}
            onOpen={() => onOpenSpace(space.id)}
            onToggleDone={() => void toggleDone(space)}
            onDelete={() => void remove(space)}
            onOpenAgent={onOpenAgent}
          />
        )} />
      </div>
    </div>
  );
}

function SpaceRow({ space, agents, onOpen, onToggleDone, onDelete, onOpenAgent }: {
  space: Space;
  agents: AgentListAllItem[];
  onOpen: () => void;
  onToggleDone: () => void;
  onDelete: () => void;
  onOpenAgent: (id: string) => void;
}) {
  const due = formatDueDate(space.due_at_utc, space.due_at);
  const running = space.agentCounts?.running ?? agents.filter((a) => a.status === 'running').length;
  const waiting = space.agentCounts ? space.agentCounts.waiting > 0 : agents.some((a) => a.status === 'waiting-approval');
  const failed = space.agentCounts ? space.agentCounts.failed > 0 : agents.some((a) => a.status === 'failed');
  const cls = ['space-item', space.status === 'done' ? 'done' : '', running > 0 ? 'has-running' : '', waiting ? 'has-waiting' : ''].filter(Boolean).join(' ');

  return (
    <div className={cls} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <button className={`space-check ${space.status === 'done' ? 'checked' : ''}`} onClick={(e) => { e.stopPropagation(); onToggleDone(); }} title="Toggle done">
        {space.status === 'done' ? '✓' : ''}
      </button>
      <div className="space-content">
        <div className={`space-desc ${running > 0 ? 'agent-active' : ''}`}>{space.description || 'Untitled'}</div>
        <div className="space-meta">
          {space.client && <span>👤 {space.client}</span>}
          {due.text && <span className={`due ${due.overdue ? 'overdue' : ''}`}>📅 {due.text}</span>}
          {space.recurrence && <span className="recurring">↻</span>}
          {running > 0 && <span className="badge running">⚡ {running} working</span>}
          {waiting && <span className="badge attention">⏳ needs attention</span>}
          {failed && <span className="badge failed">✗ failed</span>}
          <span className="muted">{timeAgo(space.updated_at)}</span>
        </div>
        {agents.length > 0 && (
          <div className="mini-agents">
            {agents.map((a) => (
              <button
                key={a.agentId}
                className={`mini-agent ${a.status}`}
                title={a.summary || a.selectedText}
                onClick={(e) => { e.stopPropagation(); onOpenAgent(a.agentId); }}
              >
                <span className="mini-glyph">{agentGlyph(a.status, a.source)}</span>
                <span className="mini-label">{(a.selectedText || a.summary || 'Agent').slice(0, 42)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="row-x" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete">✕</button>
    </div>
  );
}

// ── Workers ────────────────────────────────────────────────

function WorkersView({ client, agents, personas, page, onPage, onRefresh, onOpenAgent }: {
  client: WebRemoteClient;
  agents: AgentListAllItem[];
  personas: AgentPersona[];
  page: AgentPage;
  onPage: (cursor?: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onOpenAgent: (id: string) => void;
}) {
  const [showNew, setShowNew] = useState(false);

  return (
    <div className="stack">
      <div className="section-head">
        <h1>Workers</h1>
        <div className="section-actions">
          <button className="ghost" onClick={() => setShowNew((v) => !v)}>{showNew ? 'Close' : '+ New'}</button>
          <button className="ghost" onClick={() => void onRefresh()}>Refresh</button>
        </div>
      </div>

      {showNew && (
        <QuickLaunch client={client} personas={personas} onLaunched={async () => { setShowNew(false); await onRefresh(); }} />
      )}

      {agents.length === 0 && <Empty icon="🤖" title="No workers" detail="Deploy an agent from a canvas or with + New." />}

      <div className="space-list">
        <PageControls nextCursor={page.nextCursor} total={page.total} count={agents.length} scope="workers" load={onPage} />
        <VirtualRows rows={agents} rowId={agent => agent.agentId} total={page.total} offset={page.offset} render={agent => (
          <WorkerCard key={agent.agentId} client={client} agent={agent} onRefresh={onRefresh} onOpen={() => onOpenAgent(agent.agentId)} />
        )} />
      </div>
    </div>
  );
}

function WorkerCard({ client, agent, onRefresh, onOpen }: {
  client: WebRemoteClient;
  agent: AgentListAllItem;
  onRefresh: () => Promise<void>;
  onOpen: () => void;
}) {
  return (
    <div className="worker-card">
      <button className="worker-main" onClick={onOpen}>
        <span className={`status-dot ${agent.status}`} />
        <span className="worker-text">
          <span className="worker-title">{agent.summary || agent.selectedText || agent.agentId}</span>
          <span className="worker-meta">
            <span>{statusLabel(agent.status)}</span>
            {agent.personaHandle && <span>@{agent.personaHandle}</span>}
            <span>{agent.source === 'cca' ? 'cloud' : agent.runLocation}</span>
          </span>
        </span>
      </button>
      {agent.pendingApprovalId && (
        <Approval
          label={describeApproval({ permissionKind: agent.pendingPermissionKind || '', intention: agent.pendingIntention, path: agent.pendingPath }).label}
          detail={describeApproval({ permissionKind: agent.pendingPermissionKind || '', intention: agent.pendingIntention, path: agent.pendingPath }).detail}
          onApprove={() => void approve(client, agent, true, onRefresh)}
          onDeny={() => void approve(client, agent, false, onRefresh)}
        />
      )}
      <div className="row-actions">
        {(agent.status === 'running' || agent.status === 'waiting-approval') && (
          <button className="ghost" onClick={() => void client.invoke('agent:abort', agent.agentId).then(onRefresh)}>Abort</button>
        )}
        <button className="ghost danger" onClick={() => void client.invoke('agent:delete-session', agent.agentId).then(onRefresh)}>Delete</button>
      </div>
    </div>
  );
}

function QuickLaunch({ client, personas, onLaunched }: {
  client: WebRemoteClient;
  personas: AgentPersona[];
  onLaunched: () => Promise<void>;
}) {
  const [prompt, setPrompt] = useState('');
  const [persona, setPersona] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function launch(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true); setErr(null);
    try {
      const result = await client.invoke('agent:quick-launch', prompt.trim(), persona || undefined);
      if (result && 'error' in result && result.error) { setErr(result.error); return; }
      setPrompt('');
      await onLaunched();
    } catch (e2: any) {
      setErr(e2?.message || 'Launch failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="composer-card" onSubmit={launch}>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the agent do?" rows={4} />
      <div className="composer-row">
        <select value={persona} onChange={(e) => setPersona(e.target.value)}>
          <option value="">Default agent</option>
          {personas.map((p) => <option key={p.id} value={p.handle}>@{p.handle} ({p.runLocation})</option>)}
        </select>
        <button disabled={busy || !prompt.trim()}>{busy ? 'Deploying…' : 'Deploy'}</button>
      </div>
      {err && <div className="inline-error">{err}</div>}
    </form>
  );
}

// ── History ────────────────────────────────────────────────

function HistoryView({ client, page, onPage, onRefresh, onOpenSpace }: {
  client: WebRemoteClient;
  page: ActivityPage;
  onPage: (cursor?: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onOpenSpace: (id: string) => void;
}) {
  async function unarchive(id: string) {
    await client.invoke('space:unarchive', id);
    await onRefresh();
  }
  return (
    <div className="stack">
      {page.closedCounts && <div className="activity-summary">
        <div className="stat"><span className="stat-value">{page.closedCounts.today}</span> today</div>
        <span className="stat-sep" />
        <div className="stat"><span className="stat-value">{page.closedCounts.week}</span> this week</div>
        <span className="stat-sep" />
        <div className="stat"><span className="stat-value">{page.closedCounts.total}</span> closed</div>
      </div>}
      <PageControls nextCursor={page.nextCursor} total={page.total} count={page.items.length} scope="activity" load={onPage} />
      {page.items.length === 0 && <Empty icon="✨" title="No activity yet" detail="Complete a space to see it here." />}
      <div className="space-list">
        <VirtualRows rows={page.items} rowId={row => row.key} total={page.total} offset={page.offset} render={row => (
          <div className="history-card" role={row.spaceId ? 'button' : undefined} tabIndex={row.spaceId ? 0 : undefined}
            onClick={() => row.spaceId && onOpenSpace(row.spaceId)}
            onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && row.spaceId) { e.preventDefault(); onOpenSpace(row.spaceId); } }}>
            <span className="history-icon">{row.icon}</span>
            <div className="history-body">
              <div className="history-title">{row.title}</div>
              <div className="history-meta">
                {row.client && <span>{row.client}</span>}
                {row.agentCount > 0 && <span>{row.agentCount} workers</span>}
                <span className="muted">{new Date(row.at).toLocaleString()}</span>
              </div>
            </div>
            {row.spaceId && <button className="row-x" onClick={(e) => { e.stopPropagation(); void unarchive(row.spaceId!); }} title="Restore">↺</button>}
          </div>
        )} />
      </div>
    </div>
  );
}

// ── Canvas ─────────────────────────────────────────────────

type CanvasTargetKind = { kind: 'main' } | { kind: 'page'; page: string };

function pageCanvasSpaceId(spaceId: string, pageName: string): string {
  return `__page__${spaceId}/${encodeURIComponent(pageName)}`;
}

function CanvasScreen({ client, space, agentUpdates, personas, onClose, onOpenAgent, onRefreshAgents }: {
  client: WebRemoteClient;
  space: Space;
  agentUpdates: AgentListAllItem[];
  personas: AgentPersona[];
  onClose: () => void;
  onOpenAgent: (id: string) => void;
  onRefreshAgents: () => Promise<void>;
}) {
  const [target, setTarget] = useState<CanvasTargetKind>({ kind: 'main' });
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [panel, setPanel] = useState<'workers' | 'pages' | 'history'>('workers');
  const [workerPage, setWorkerPage] = useState<AgentPage>({
    items: [], total: 0, nextCursor: null, counts: { running: 0, waiting: 0, completed: 0, failed: 0 },
  });
  const [workerError, setWorkerError] = useState('');
  const workerCursor = useRef<string | undefined>(undefined);
  const workerRequest = useRef(0);
  const loadWorkers = useCallback(async (cursor?: string) => {
    workerCursor.current = cursor;
    const request = ++workerRequest.current;
    const page = await client.invoke('agent:list-page', { spaceId: space.id, includePages: true, cursor });
    if (request === workerRequest.current) {
      setWorkerPage(page);
      setWorkerError('');
    }
  }, [client, space.id]);
  useEffect(() => {
    let active = true;
    void loadWorkers(workerCursor.current).catch(error => { if (active) setWorkerError(String(error)); });
    return () => { active = false; ++workerRequest.current; };
  }, [loadWorkers, agentUpdates]);

  const [saveError, setSaveError] = useState('');
  const saveTimer = useRef<number | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const contentRef = useRef('');

  const setEditorContent = useCallback((next: string): void => {
    contentRef.current = next;
    setContent(next);
  }, []);
  const saves = useMemo(() => new DocumentSave(
    () => contentRef.current, setEditorContent,
    next => target.kind === 'main'
      ? client.invoke('canvas:write', space.id, next)
      : client.invoke('canvas:write-page', space.id, target.page, next),
  ), [client, space.id, target, setEditorContent]);
  const showSaveError = useCallback((error: unknown) => {
    setSaveState('idle');
    setSaveError(error instanceof Error ? error.message : 'Document could not save. Your text is kept.');
  }, []);
  const loadRevision = useRef(0);

  const load = useCallback(async () => {
    if (saves.hasDirty()) throw new Error('Save the current edits before reloading this document.');
    const revision = ++loadRevision.current;
    setLoaded(false);
    const result = target.kind === 'main'
      ? await client.invoke('canvas:read', space.id)
      : await client.invoke('canvas:read-page', space.id, target.page);
    if (revision !== loadRevision.current) return;
    if (saves.hasDirty()) throw new Error('Newer edits were kept instead of replacing them with a reload.');
    if ('error' in result && result.error) throw new Error(result.error);
    setEditorContent('content' in result ? result.content : '');
    setLoaded(true);
  }, [client, space.id, target, setEditorContent, saves]);

  useEffect(() => {
    void load().catch(showSaveError);
    return () => { ++loadRevision.current; };
  }, [load, showSaveError]);

  useEffect(() => () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!saves.hasDirty()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [saves]);

  // Pick up live canvas edits from agents when not actively editing.
  useEffect(() => {
    function onUpdate(e: Event) {
      const detail = (e as CustomEvent).detail as { spaceId?: string; content?: string };
      const targetSpaceId = target.kind === 'main' ? space.id : pageCanvasSpaceId(space.id, target.page);
      if (detail?.spaceId === targetSpaceId && !saves.hasDirty() && typeof detail.content === 'string') {
        setEditorContent(detail.content);
      }
    }
    window.addEventListener('whim:canvas-updated', onUpdate);
    return () => window.removeEventListener('whim:canvas-updated', onUpdate);
  }, [space.id, target, setEditorContent, saves]);

  const doSave = useCallback(async () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    setSaveState('saving');
    await saves.flush();
    setSaveError('');
    setSaveState('saved');
    window.setTimeout(() => setSaveState('idle'), 1200);
  }, [saves]);

  function onEdit(next: string) {
    setEditorContent(next);
    saves.changed();
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void doSave().catch(showSaveError); }, 1500);
  }

  async function switchTarget(nextTarget: CanvasTargetKind): Promise<void> {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    if (saves.hasDirty()) await doSave();
    setTarget(nextTarget);
    setEditing(false);
  }

  async function close() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    if (saves.hasDirty()) await doSave();
    if (target.kind === 'main') {
      const result = await client.invoke('canvas:close', space.id, contentRef.current);
      if (!result.success) throw new Error(result.error || 'Document could not close. Your text is kept.');
    }
    onClose();
  }

  return (
    <div className="screen canvas-screen">
      <header className="screen-top">
        <button className="ghost icon-btn" onClick={() => { void close().catch(showSaveError); }} title="Back">‹</button>
        <div className="screen-title">
          <div className="screen-title-main">{space.description || 'Canvas'}</div>
          {target.kind === 'page' && <div className="screen-subtitle">{target.page}</div>}
        </div>
        <div className="screen-top-actions">
          {saveState !== 'idle' && <span className="save-state">{saveState === 'saving' ? 'Saving…' : 'Saved'}</span>}
          <button className={`ghost ${editing ? 'active' : ''}`} onClick={() => {
            if (editing && saves.hasDirty()) {
              void doSave().then(() => setEditing(false)).catch(showSaveError);
            } else setEditing((v) => !v);
          }}>
            {editing ? 'Preview' : 'Edit'}
          </button>
        </div>
      </header>
      {saveError && <div role="alert" className="error">{saveError} <button onClick={() => {
        void (loaded ? doSave() : load()).catch(showSaveError);
      }}>{loaded ? 'Retry save' : 'Retry load'}</button></div>}

      <div className="canvas-body">
        {!loaded ? (
          <div className="loading">Loading…</div>
        ) : editing ? (
          <textarea
            ref={textRef}
            className="canvas-edit"
            value={content}
            onChange={(e) => onEdit(e.target.value)}
            placeholder="Write markdown…"
            spellCheck={false}
          />
        ) : content.trim() ? (
          <CanvasMarkdown spaceId={space.id} content={content} />
        ) : (
          <div className="canvas-empty" onClick={() => setEditing(true)}>This canvas is empty. Tap Edit to start writing.</div>
        )}
      </div>

      <div className="canvas-dock">
        <div className="dock-tabs">
          <button className={panel === 'workers' ? 'active' : ''} onClick={() => setPanel('workers')}>Workers {workerPage.total > 0 && <span className="pill">{workerPage.total}</span>}</button>
          <button className={panel === 'pages' ? 'active' : ''} onClick={() => setPanel('pages')}>Pages</button>
          <button className={panel === 'history' ? 'active' : ''} onClick={() => setPanel('history')}>History</button>
        </div>
        <div className="dock-body">
          {panel === 'workers' && (
            <>
              {workerError && <p role="alert">{workerError}</p>}
              <PageControls nextCursor={workerPage.nextCursor} total={workerPage.total} count={workerPage.items.length}
                scope={`canvas:${space.id}`} load={loadWorkers} />
              <CanvasWorkers client={client} space={space} target={target} agents={workerPage.items} personas={personas} selection={() => readSelection(textRef.current)} onOpenAgent={onOpenAgent} onRefreshAgents={onRefreshAgents} />
            </>
          )}
          {panel === 'pages' && <CanvasPages client={client} space={space} onOpenPage={(page) => { void switchTarget({ kind: 'page', page }).catch(showSaveError); }} active={target.kind === 'page' ? target.page : null} onOpenMain={() => { void switchTarget({ kind: 'main' }).catch(showSaveError); }} />}
          {panel === 'history' && <CanvasHistory client={client} space={space} onRestored={load} />}
        </div>
      </div>
    </div>
  );
}

function readSelection(el: HTMLTextAreaElement | null): string {
  if (!el) return '';
  const { selectionStart, selectionEnd, value } = el;
  if (selectionStart == null || selectionEnd == null || selectionStart === selectionEnd) return '';
  return value.slice(selectionStart, selectionEnd);
}

function CanvasWorkers({ client, space, target, agents, personas, selection, onOpenAgent, onRefreshAgents }: {
  client: WebRemoteClient;
  space: Space;
  target: CanvasTargetKind;
  agents: AgentListAllItem[];
  personas: AgentPersona[];
  selection: () => string;
  onOpenAgent: (id: string) => void;
  onRefreshAgents: () => Promise<void>;
}) {
  const [instruction, setInstruction] = useState('');
  const [persona, setPersona] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function deploy(e: React.FormEvent) {
    e.preventDefault();
    const task = instruction.trim();
    if (!task) return;
    setBusy(true); setErr(null);
    try {
      const quoted = selection();
      let result: any;
      const launchSpaceId = target.kind === 'page' ? pageCanvasSpaceId(space.id, target.page) : space.id;
      const effectivePersona = persona || (target.kind === 'page' ? personas[0]?.handle ?? '' : '');
      if (effectivePersona) {
        result = await client.invoke('agent:launch-from-comment', launchSpaceId, task, quoted, { quote: quoted, prefix: '', suffix: '' }, effectivePersona, null);
      } else if (target.kind === 'page') {
        setErr('Choose a persona before deploying an agent on a child page.');
        return;
      } else {
        result = await client.invoke('agent:launch', space.id, task, { quote: quoted || task, prefix: '', suffix: '' });
      }
      if (result && 'error' in result && result.error) { setErr(result.error); return; }
      setInstruction('');
      await onRefreshAgents();
    } catch (e2: any) {
      setErr(e2?.message || 'Failed to deploy agent');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <form className="composer-card" onSubmit={deploy}>
        <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Deploy an agent on this canvas…" rows={3} />
        <div className="composer-row">
          <select value={persona} onChange={(e) => setPersona(e.target.value)}>
            <option value="">Default agent</option>
            {personas.map((p) => <option key={p.id} value={p.handle}>@{p.handle} ({p.runLocation})</option>)}
          </select>
          <button disabled={busy || !instruction.trim()}>{busy ? 'Deploying…' : 'Deploy'}</button>
        </div>
        <div className="composer-hint">Select text in Edit mode to scope the agent to it.</div>
        {err && <div className="inline-error">{err}</div>}
      </form>

      {agents.length === 0 ? (
        <Empty icon="🤖" title="No agents on this canvas" detail="Deploy one above." />
      ) : (
        agents.map((agent) => (
          <WorkerCard key={agent.agentId} client={client} agent={agent} onRefresh={onRefreshAgents} onOpen={() => onOpenAgent(agent.agentId)} />
        ))
      )}
    </div>
  );
}

function CanvasPages({ client, space, onOpenPage, onOpenMain, active }: {
  client: WebRemoteClient;
  space: Space;
  onOpenPage: (page: string) => void;
  onOpenMain: () => void;
  active: string | null;
}) {
  const [pages, setPages] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await client.invoke('canvas:list-pages', space.id);
    setPages('pages' in result ? result.pages : []);
  }, [client, space.id]);

  useEffect(() => { void load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const result = await client.invoke('canvas:create-page', space.id, name.trim());
      setName('');
      await load();
      if ('page' in result && result.page) onOpenPage(result.page.replace(/\.md$/, ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <button className={`page-item ${active === null ? 'active' : ''}`} onClick={onOpenMain}>📄 canvas <span className="muted">(main)</span></button>
      {pages.map((page) => (
        <button key={page} className={`page-item ${active === page.replace(/\.md$/, '') ? 'active' : ''}`} onClick={() => onOpenPage(page.replace(/\.md$/, ''))}>
          📄 {page.replace(/\.md$/, '')}
        </button>
      ))}
      <form className="composer-row" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New page name" />
        <button disabled={busy || !name.trim()}>Add</button>
      </form>
    </div>
  );
}

function CanvasHistory({ client, space, onRestored }: {
  client: WebRemoteClient;
  space: Space;
  onRestored: () => Promise<void>;
}) {
  const [commits, setCommits] = useState<HistoryCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<{ sha: string; content: string } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const result = await client.invoke('canvas:history', space.id);
      if (active) { setCommits(('commits' in result ? result.commits : []) as HistoryCommit[]); setLoading(false); }
    })();
    return () => { active = false; };
  }, [client, space.id]);

  async function showPreview(sha: string) {
    const result = await client.invoke('canvas:preview-version', space.id, sha);
    setPreview({ sha, content: 'content' in result ? result.content : '' });
  }

  async function restore(sha: string) {
    if (!confirm('Restore this version? Current content will be committed first.')) return;
    await client.invoke('canvas:restore', space.id, sha);
    setPreview(null);
    await onRestored();
  }

  if (loading) return <div className="loading">Loading history…</div>;
  if (commits.length === 0) return <Empty icon="🕓" title="No history yet" detail="Edits are auto-committed to git." />;

  return (
    <div className="stack">
      {commits.map((c) => (
        <div key={c.sha} className="commit-item">
          <button className="commit-main" onClick={() => void showPreview(c.sha)}>
            <span className="commit-msg">{c.message}</span>
            <span className="muted">{c.relativeDate || timeAgo(c.date)} · {(c.shortSha || c.sha).slice(0, 7)}</span>
          </button>
          <button className="ghost" onClick={() => void restore(c.sha)}>Restore</button>
        </div>
      ))}
      {preview && (
        <div className="screen preview-screen">
          <header className="screen-top">
            <button className="ghost icon-btn" onClick={() => setPreview(null)}>‹</button>
            <div className="screen-title"><div className="screen-title-main">Version {preview.sha.slice(0, 7)}</div></div>
            <button className="ghost" onClick={() => void restore(preview.sha)}>Restore</button>
          </header>
          <div className="canvas-body"><CanvasMarkdown spaceId={space.id} content={preview.content || '_empty_'} /></div>
        </div>
      )}
    </div>
  );
}

// ── Chat ───────────────────────────────────────────────────

function ChatScreen({ client, agent, interactions, registerLive, unregisterLive, onClose, onRefreshAgents }: {
  client: WebRemoteClient;
  agent: AgentListAllItem;
  interactions: PendingInteraction[];
  registerLive: (agentId: string, cb: (e: ChatEvent) => void) => void;
  unregisterLive: () => void;
  onClose: () => void;
  onRefreshAgents: () => Promise<void>;
}) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadingHistory = useRef(false);
  const pendingEvents = useRef<ChatEvent[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderFlight = useRef(false);
  const following = useRef(true);
  const watermark = useRef(0);
  const agentGeneration = useRef(0);
  const localHistoryIds = useRef(new Set<string>());
  const [sendError, setSendError] = useState('');
  const [historyApprovals, setHistoryApprovals] = useState<ApprovalMessage[]>([]);
  const [historyQuestions, setHistoryQuestions] = useState<PendingInteraction[]>([]);

  useEffect(() => {
    let active = true;
    const generation = ++agentGeneration.current;
    loadingHistory.current = true;
    pendingEvents.current = [];
    setLoading(true);
    const batch = createEventBatch(event => {
      if (loadingHistory.current) {
        pendingEvents.current.push(event);
        return;
      }
      if (event.type === 'approval.resolved') setHistoryApprovals(current => current.filter(item => item.requestId !== event.requestId));
      if (event.type === 'elicitation.resolved') setHistoryQuestions(current => current.filter(item => item.requestId !== event.requestId));
      setBubbles((prev) => applyChatEvent(prev, event));
    });
    const seen = new Set<string>();
    registerLive(agent.agentId, event => {
      if (!active || (event.sequence !== undefined && event.sequence <= watermark.current)) return;
      if (event.eventId) {
        if (seen.has(event.eventId)) return;
        seen.add(event.eventId);
        if (seen.size > 4096) seen.delete(seen.values().next().value!);
      }
      batch.push(event);
    });
    (async () => {
      try {
        const page = await client.invoke('agent:history-page', agent.agentId);
        const result = page.legacySession ? await client.invoke('agent:get-history', agent.agentId) : null;
        if (active) {
          if (result && 'error' in result) throw new Error(result.error);
          const history = result && 'events' in result ? parseHistory(result.events) : historyBubbles(page.items);
          setOlderCursor(page.nextCursor);
          watermark.current = page.watermark;
          batch.flush();
          const buffered = pendingEvents.current.filter(event => event.sequence === undefined || event.sequence > page.watermark);
          const resolved = new Set(buffered.flatMap(event =>
            event.type === 'approval.resolved' || event.type === 'elicitation.resolved' ? [event.requestId] : []));
          setHistoryApprovals(page.items.filter((item): item is ApprovalMessage =>
            item.type === 'approval' && !item.responded && !resolved.has(item.requestId)));
          setHistoryQuestions(page.items.flatMap<PendingInteraction>(item =>
            item.type === 'elicitation' && !item.responded && !resolved.has(item.requestId) ? [{
              kind: 'elicitation', agentId: agent.agentId, requestId: item.requestId,
              message: item.message, mode: item.mode === 'url' ? 'url' : 'form', source: item.elicitationSource ?? null,
            }] : []));
          pendingEvents.current = [];
          loadingHistory.current = false;
          const localIds = new Set(localHistoryIds.current);
          localHistoryIds.current.clear();
          setBubbles(current => {
            return applyChatEvents(mergeHistoryWithLocal(history, current, localIds), buffered);
          });
        }
      } catch (error) {
        if (active) {
          setHistoryError(error instanceof Error ? error.message : 'Could not load conversation');
          batch.flush();
          const buffered = pendingEvents.current;
          pendingEvents.current = [];
          loadingHistory.current = false;
          localHistoryIds.current.clear();
          setBubbles(current => applyChatEvents(current, buffered));
        }
      } finally {
        if (active) {
          setLoading(false);
        } else {
          loadingHistory.current = false;
          pendingEvents.current = [];
        }
      }
    })();
    return () => {
      active = false; agentGeneration.current = generation + 1;
      batch.dispose(); loadingHistory.current = false; pendingEvents.current = []; unregisterLive();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, agent.agentId]);

  useEffect(() => {
    if (following.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles]);

  async function loadOlder() {
    if (!olderCursor || olderFlight.current) return;
    olderFlight.current = true;
    setLoadingOlder(true);
    const generation = agentGeneration.current;
    setHistoryError('');
    try {
      const page = await client.invoke('agent:history-page', agent.agentId, { cursor: olderCursor });
      if (generation !== agentGeneration.current) return;
      const resolved = new Set(page.items.flatMap(item => 'responded' in item && item.responded ? [item.requestId] : []));
      setHistoryApprovals(current => current.filter(item => !resolved.has(item.requestId)));
      setHistoryQuestions(current => current.filter(item => !resolved.has(item.requestId)));
      following.current = false;
      setOlderCursor(page.nextCursor);
      setBubbles(current => {
        const ids = new Set(current.map(row => row.id));
        return orderTranscript([...historyBubbles(page.items).filter(row => !ids.has(row.id)), ...current]);
      });
    } catch (error) {
      if (generation === agentGeneration.current) setHistoryError(String(error));
    } finally {
      olderFlight.current = false;
      if (generation === agentGeneration.current) setLoadingOlder(false);
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError('');
    const localId = crypto.randomUUID();
    if (loadingHistory.current) localHistoryIds.current.add(localId);
    setBubbles((prev) => [...prev, { kind: 'user', id: localId, text }]);
    setMessage('');
    try {
      const result = await client.invoke('chat:send-message', agent.agentId, text);
      if (result.error) throw new Error(result.error);
      if (result.messageId) {
        if (localHistoryIds.current.delete(localId)) localHistoryIds.current.add(`user:${result.messageId}`);
        setBubbles(current => acknowledgeUserMessage(current, localId, result.messageId!));
      }
      await onRefreshAgents();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Could not send message');
      setMessage(current => current || text);
    } finally {
      setSending(false);
    }
  }

  const approvalDesc = describeApproval({ permissionKind: agent.pendingPermissionKind || '', intention: agent.pendingIntention, path: agent.pendingPath });

  return (
    <div className="screen chat-screen">
      <header className="screen-top">
        <button className="ghost icon-btn" onClick={onClose} title="Back">‹</button>
        <div className="screen-title">
          <div className="screen-title-main">{agent.summary || agent.selectedText || 'Agent'}</div>
          <div className="screen-subtitle"><span className={`status-dot ${agent.status}`} /> {statusLabel(agent.status)}{agent.personaHandle ? ` · @${agent.personaHandle}` : ''}</div>
        </div>
      </header>

      {(agent.pendingApprovalId || historyApprovals.length > 0 || historyQuestions.length > 0 || interactions.length > 0) && (
      <section aria-label="Pending requests" style={{ maxHeight: '40vh', overflowY: 'auto', flexShrink: 0 }}>
      {agent.pendingApprovalId && (
        <Approval
          label={approvalDesc.label}
          detail={approvalDesc.detail}
          onApprove={() => void approve(client, agent, true, onRefreshAgents)}
          onDeny={() => void approve(client, agent, false, onRefreshAgents)}
        />
      )}

      {historyApprovals.filter(item => item.requestId !== agent.pendingApprovalId).map(item => {
        const description = describeApproval({ permissionKind: item.permissionKind, intention: item.intention, path: item.path });
        const respond = async (approved: boolean) => {
          try {
            await client.invoke('agent:approve', agent.agentId, item.requestId, approved);
            await onRefreshAgents();
          } catch (error) { setHistoryError(error instanceof Error ? error.message : 'Could not respond to approval'); }
        };
        return <Approval key={item.requestId} label={description.label} detail={description.detail}
          onApprove={() => void respond(true)} onDeny={() => void respond(false)} />;
      })}
      {[...historyQuestions.filter(item => !interactions.some(live => live.requestId === item.requestId)), ...interactions].map((item) => (
        <InteractionTile key={item.requestId} client={client} item={item} onRefreshAgents={onRefreshAgents} />
      ))}
      </section>
      )}

      {olderCursor && <button disabled={loadingOlder} onClick={() => void loadOlder()}>
        {loadingOlder ? 'Loading earlier history...' : 'Load earlier history'}
      </button>}
      {historyError && <p role="alert">{historyError}</p>}
      {sendError && <p role="alert">{sendError}</p>}
      <div className="chat-scroll" ref={scrollRef} onScroll={event => {
        const node = event.currentTarget;
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
      }}>
        {loading && <div className="loading">Loading conversation…</div>}
        {!loading && bubbles.length === 0 && <Empty icon="💬" title="No messages yet" detail="Send a message to continue." />}
        <VirtualRows rows={bubbles} rowId={bubble => bubble.id} render={bubble => <BubbleView bubble={bubble} />} />
      </div>

      <form className="chat-composer" onSubmit={send}>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(e as any); } }}
          placeholder="Message this agent…"
          rows={2}
        />
        <button disabled={sending || !message.trim()}>{sending ? '…' : 'Send'}</button>
      </form>
    </div>
  );
}

function BubbleView({ bubble }: { bubble: Bubble }) {
  if (bubble.kind === 'user') {
    return <div className="bubble user"><div className="bubble-body">{bubble.text}</div></div>;
  }
  if (bubble.kind === 'assistant') {
    return (
      <div className="bubble assistant">
        <div className="bubble-body markdown"><FeatureBoundary fallback={bubble.text}>
          <Suspense fallback={bubble.text}><Markdown>{bubble.text || '…'}</Markdown></Suspense>
        </FeatureBoundary></div>
      </div>
    );
  }
  if (bubble.kind === 'reasoning') {
    return <div className="bubble reasoning"><div className="bubble-body">{bubble.text}</div></div>;
  }
  if (bubble.kind === 'tool') {
    return (
      <div className={`tool-line ${bubble.status}`}>
        <span className="tool-glyph">{bubble.status === 'running' ? '◐' : bubble.status === 'error' ? '✗' : '✓'}</span>
        <span className="tool-name">{humanizeToolName(bubble.toolName, bubble.args)}</span>
      </div>
    );
  }
  return <div className={`event-line ${bubble.level}`}>{bubble.text}</div>;
}

/**
 * Renders whichever question the agent is blocked on.  Without these the web
 * UI could only ever answer permission approvals, so any agent that asked a
 * question, raised an elicitation, or hit the sandbox was stuck until someone
 * walked back to the desktop.
 */
function InteractionTile({ client, item, onRefreshAgents }: {
  client: WebRemoteClient;
  item: PendingInteraction;
  onRefreshAgents: () => Promise<void>;
}) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await onRefreshAgents();
    } finally {
      setBusy(false);
    }
  }

  if (item.kind === 'user-input') {
    return (
      <div className="approval interaction">
        <div className="approval-text"><strong>Agent asked a question</strong><span>{item.question}</span></div>
        {item.choices.length > 0 && (
          <div className="approval-actions wrap">
            {item.choices.map((choice) => (
              <button
                key={choice}
                disabled={busy}
                onClick={() => void run(() => client.invoke('agent:respond-user-input', item.agentId, item.requestId, choice, false))}
              >{choice}</button>
            ))}
          </div>
        )}
        {item.allowFreeform && (
          <form
            className="interaction-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!answer.trim()) return;
              void run(() => client.invoke('agent:respond-user-input', item.agentId, item.requestId, answer.trim(), true));
            }}
          >
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Type an answer…" />
            <button disabled={busy || !answer.trim()}>Reply</button>
          </form>
        )}
      </div>
    );
  }

  if (item.kind === 'elicitation') {
    // Structured form elicitation needs a schema renderer; until the desktop
    // form is shared, be explicit rather than silently offering a broken form.
    return (
      <div className="approval interaction">
        <div className="approval-text">
          <strong>{item.source ? `${item.source} needs input` : 'A tool needs input'}</strong>
          <span>{item.message}</span>
          {item.mode === 'form' && <em>Structured forms must be filled in on the desktop app.</em>}
        </div>
        <div className="approval-actions">
          <button
            disabled={busy || item.mode === 'form'}
            onClick={() => void run(() => client.invoke('agent:respond-elicitation', item.agentId, item.requestId, 'accept', {}))}
          >Accept</button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => void run(() => client.invoke('agent:respond-elicitation', item.agentId, item.requestId, 'decline', {}))}
          >Decline</button>
        </div>
      </div>
    );
  }

  const decisionLabels: Record<string, string> = {
    'allow-once': 'Allow once',
    'allow-for-session': 'Allow for session',
    disable: 'Disable sandbox',
  };
  return (
    <div className="approval interaction">
      <div className="approval-text">
        <strong>Sandbox blocked {item.toolName || 'an action'}</strong>
        <code>{item.target}</code>
        {item.intention && <span>{item.intention}</span>}
      </div>
      <div className="approval-actions wrap">
        {item.decisions.map((decision) => (
          <button
            key={decision}
            className={decision === 'disable' ? 'danger' : ''}
            disabled={busy}
            onClick={() => void run(() => client.invoke('agent:resolve-sandbox', item.agentId, item.requestId, decision))}
          >{decisionLabels[decision] ?? decision}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * Canvas markdown stores images as workspace-relative paths
 * (`attachments/shot.png`) that only mean something next to the space folder.
 * The desktop resolves them over IPC; in the browser they have to be routed
 * through the server's attachment endpoint or every image renders broken.
 */
function CanvasMarkdown({ spaceId, content }: { spaceId: string; content: string }) {
  const components = useMemo(() => ({
    img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => {
      const src = typeof props.src === 'string' ? props.src : '';
      const isAbsolute = /^(https?:|data:|blob:|\/)/i.test(src);
      const resolved = !src || isAbsolute
        ? src
        : `/api/attachment?spaceId=${encodeURIComponent(spaceId)}&path=${encodeURIComponent(src)}`;
      return <img {...props} src={resolved} loading="lazy" />;
    },
  }), [spaceId]);

  return (
    <div className="markdown">
      <FeatureBoundary fallback={<pre>{content}</pre>}>
        <Suspense fallback={<pre>{content}</pre>}><Markdown components={components}>{content}</Markdown></Suspense>
      </FeatureBoundary>
    </div>
  );
}

// ── Shared bits ────────────────────────────────────────────

function Approval({ label, detail, onApprove, onDeny }: { label: string; detail: string; onApprove: () => void; onDeny: () => void }) {
  return (
    <div className="approval">
      <div className="approval-text">
        <strong>{label}</strong>
        {detail && <code>{detail}</code>}
      </div>
      <div className="approval-actions">
        <button onClick={onApprove}>Approve</button>
        <button className="danger" onClick={onDeny}>Deny</button>
      </div>
    </div>
  );
}

function Empty({ icon, title, detail }: { icon: string; title: string; detail: string }) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

async function approve(client: WebRemoteClient, agent: AgentListAllItem, approved: boolean, onRefresh: () => Promise<void>): Promise<void> {
  if (!agent.pendingApprovalId) return;
  await client.invoke('agent:approve', agent.agentId, agent.pendingApprovalId, approved);
  await onRefresh();
}

registerServiceWorker();

createRoot(document.getElementById('root')!).render(<App />);
