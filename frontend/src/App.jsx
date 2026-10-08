// Dashboard shell: business filter, the floor, the pending queue and the log.
// All state changes arrive over the socket — which is fed by Postgres NOTIFY —
// so a change made by n8n or psql lands here the same as one made by a click.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api.js';
import VirtualOfficeCanvas from './components/VirtualOfficeCanvas.jsx';
import ApprovalModal from './components/ApprovalModal.jsx';

const REVIEWER = 'dashboard';

const STATUS_PILL = {
  IDLE: 'bg-slate-800 text-slate-300',
  WORKING: 'bg-cyan-950 text-cyan-300',
  AWAITING_APPROVAL: 'bg-amber-950 text-amber-300',
  PAUSED: 'bg-red-950 text-red-300',
};

const timeOf = (value) =>
  new Date(value).toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

export default function App() {
  const [businessId, setBusinessId] = useState('all');
  const [businesses, setBusinesses] = useState([]);
  const [agents, setAgents] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [logs, setLogs] = useState([]);
  const [connection, setConnection] = useState('connecting');
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [error, setError] = useState(null);

  const socketRef = useRef(null);
  const businessRef = useRef(businessId);
  businessRef.current = businessId;

  const load = useCallback(async (scopeId) => {
    try {
      const state = await api.state(scopeId);
      // A slow response for an abandoned filter must not overwrite the current one.
      if (businessRef.current !== scopeId) return;
      setBusinesses(state.businesses);
      setAgents(state.agents);
      setApprovals(state.approvals);
      setLogs(state.logs);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(businessId); }, [businessId, load]);

  // One socket for the session; the room changes with the filter.
  useEffect(() => {
    const socket = io(import.meta.env.VITE_API_BASE ?? '/', {
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnection('live');
      socket.emit('subscribe', { businessId: businessRef.current });
      load(businessRef.current);
    });
    socket.on('disconnect', () => setConnection('offline'));
    socket.on('realtime:degraded', () => setConnection('degraded'));
    socket.on('resync', () => load(businessRef.current));

    socket.on('agent:update', (agent) => {
      setAgents((current) => {
        if (agent.deleted) return current.filter((a) => a.id !== agent.id);
        const index = current.findIndex((a) => a.id === agent.id);
        if (index === -1) return [...current, agent];
        const next = current.slice();
        next[index] = agent;
        return next;
      });
    });

    socket.on('approval:update', (approval) => {
      setApprovals((current) => {
        const without = current.filter((a) => a.id !== approval.id);
        // The queue only holds what still needs a human.
        return approval.status === 'PENDING' ? [approval, ...without] : without;
      });
    });

    socket.on('log:append', (log) => {
      setLogs((current) => [log, ...current].slice(0, 60));
    });

    return () => { socket.close(); socketRef.current = null; };
  }, [load]);

  useEffect(() => {
    socketRef.current?.emit('subscribe', { businessId });
  }, [businessId]);

  const pendingByAgent = useMemo(() => {
    const map = new Map();
    for (const approval of approvals) {
      if (!map.has(approval.agent_id)) map.set(approval.agent_id, approval);
    }
    return map;
  }, [approvals]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
  const selectedApproval = selectedAgentId ? pendingByAgent.get(selectedAgentId) ?? null : null;
  const businessName = (id) => businesses.find((b) => b.id === id)?.name ?? '—';

  const act = async (fn) => {
    try {
      await fn();
    } catch (err) {
      setError(err.message);
      throw err;
    }
  };

  return (
    <div className="min-h-full bg-slate-950">
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
          <h1 className="text-lg font-semibold text-slate-100">Virtual Office</h1>

          <label className="flex items-center gap-2 text-sm text-slate-400">
            Business
            <select
              value={businessId}
              onChange={(e) => { setSelectedAgentId(null); setBusinessId(e.target.value); }}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100 outline-none focus:border-sky-500"
            >
              <option value="all">All businesses</option>
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </label>

          <span className="flex-1" />

          <span className="flex items-center gap-2 text-xs text-slate-400">
            <span
              className={`h-2 w-2 rounded-full ${
                connection === 'live' ? 'bg-emerald-400'
                  : connection === 'degraded' ? 'bg-amber-400' : 'bg-red-500'
              }`}
            />
            {connection === 'live' ? 'realtime' : connection}
          </span>
          <span className="rounded-full bg-amber-950 px-3 py-1 text-xs text-amber-300">
            {approvals.length} awaiting approval
          </span>
        </div>
      </header>

      {error && (
        <p className="mx-auto max-w-7xl px-4 pt-3 text-sm text-red-300">{error}</p>
      )}

      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-4">
          <VirtualOfficeCanvas agents={agents} onSelectAgent={(a) => setSelectedAgentId(a.id)} />

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => setSelectedAgentId(agent.id)}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900 p-3 text-left hover:border-slate-600"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-100">{agent.name}</span>
                  <span className="block font-mono text-xs text-slate-500">
                    {agent.department}
                    {businessId === 'all' && ` · ${businessName(agent.business_id)}`}
                  </span>
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${STATUS_PILL[agent.status]}`}>
                  {agent.status.replace('_', ' ').toLowerCase()}
                </span>
              </button>
            ))}
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900">
            <h2 className="border-b border-slate-800 px-4 py-3 text-sm font-medium text-slate-200">
              Pending approvals
            </h2>
            {approvals.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">
                Nothing waiting. Drafts land here the moment an agent files one.
              </p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {approvals.map((approval) => (
                  <li key={approval.id}>
                    <button
                      onClick={() => setSelectedAgentId(approval.agent_id)}
                      className="w-full px-4 py-3 text-left hover:bg-slate-800/60"
                    >
                      <p className="truncate text-sm text-slate-100">
                        {approval.payload_json?.title ?? 'Draft'}
                      </p>
                      <p className="font-mono text-xs text-slate-500">
                        {approval.agent_department} · {approval.agent_name} · {timeOf(approval.created_at)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900">
            <h2 className="border-b border-slate-800 px-4 py-3 text-sm font-medium text-slate-200">
              Activity
            </h2>
            <ul className="max-h-80 divide-y divide-slate-800 overflow-y-auto">
              {logs.map((log) => (
                <li key={log.id} className="px-4 py-2 text-xs">
                  <span className="font-mono text-slate-400">{log.action}</span>
                  <span className="text-slate-600"> · {log.agent_name ?? 'system'}</span>
                  <span className="float-right text-slate-600">{timeOf(log.created_at)}</span>
                </li>
              ))}
              {logs.length === 0 && (
                <li className="px-4 py-3 text-sm text-slate-500">No activity yet.</li>
              )}
            </ul>
          </div>
        </aside>
      </main>

      {selectedAgent && (
        <ApprovalModal
          agent={selectedAgent}
          approval={selectedApproval}
          onClose={() => setSelectedAgentId(null)}
          onApprove={(id) => act(() => api.approve(id, REVIEWER))}
          onReject={(id, feedback) => act(() => api.reject(id, feedback, REVIEWER))}
          onKill={(agentId, resume) => act(() => api.kill(agentId, resume, REVIEWER))}
        />
      )}
    </div>
  );
}
