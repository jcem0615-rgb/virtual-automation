// Thin REST wrapper. Vite proxies /api to the backend in dev; in the container
// the frontend is served by nginx which proxies the same paths.
const BASE = import.meta.env.VITE_API_BASE ?? '';

// Raised when the session is gone, so App can drop straight back to sign-in.
export class Unauthorized extends Error {}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',   // the session cookie
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = body?.error ?? `HTTP ${res.status}`;
    const err = res.status === 401 ? new Unauthorized(message) : new Error(message);
    err.status = res.status;
    err.detail = body?.detail;
    throw err;
  }
  return body;
}

const scope = (businessId) =>
  businessId && businessId !== 'all' ? `?business_id=${businessId}` : '';

export const api = {
  me: () => request('/api/auth/me'),
  login: (email, password) =>
    request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  state: (businessId) => request(`/api/state${scope(businessId)}`),
  approvals: (businessId, status = 'PENDING') => {
    const params = new URLSearchParams({ status });
    if (businessId && businessId !== 'all') params.set('business_id', businessId);
    return request(`/api/approvals?${params}`);
  },
  approve: (id) => request(`/api/approvals/${id}/approve`, { method: 'POST' }),
  reject: (id, feedback) =>
    request(`/api/approvals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ feedback }),
    }),
  kill: (agentId, resume) =>
    request(`/api/agents/${agentId}/kill`, {
      method: 'POST',
      body: JSON.stringify({ resume }),
    }),
};
