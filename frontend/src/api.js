// Thin REST wrapper. Vite proxies /api to the backend in dev; in the container
// the frontend is served by nginx which proxies the same paths.
const BASE = import.meta.env.VITE_API_BASE ?? '';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.detail = body?.detail;
    throw err;
  }
  return body;
}

const scope = (businessId) =>
  businessId && businessId !== 'all' ? `?business_id=${businessId}` : '';

export const api = {
  state: (businessId) => request(`/api/state${scope(businessId)}`),
  approvals: (businessId, status = 'PENDING') => {
    const params = new URLSearchParams({ status });
    if (businessId && businessId !== 'all') params.set('business_id', businessId);
    return request(`/api/approvals?${params}`);
  },
  approve: (id, reviewer) =>
    request(`/api/approvals/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reviewer }),
    }),
  reject: (id, feedback, reviewer) =>
    request(`/api/approvals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ feedback, reviewer }),
    }),
  kill: (agentId, resume, reviewer) =>
    request(`/api/agents/${agentId}/kill`, {
      method: 'POST',
      body: JSON.stringify({ resume, reviewer }),
    }),
};
