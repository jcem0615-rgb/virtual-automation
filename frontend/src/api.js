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
  posts: (businessId, platform = 'all') => {
    const params = new URLSearchParams();
    if (businessId && businessId !== 'all') params.set('business_id', businessId);
    if (platform && platform !== 'all') params.set('platform', platform);
    return request(`/api/posts?${params}`);
  },
  editPost: (id, body) =>
    request(`/api/posts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  publishPost: (id, platforms) =>
    request(`/api/posts/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify(platforms ? { platforms } : {}),
    }),
  // Which desks this floor has, and which it could have back.
  departments: (businessId) => request(`/api/departments?business_id=${businessId}`),
  removeDesk: (agentId) => request(`/api/agents/${agentId}`, { method: 'DELETE' }),
  addDesk: (businessId, department) =>
    request('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ business_id: businessId, department }),
    }),

  setSkill: (agentId, key, enabled) =>
    request(`/api/agents/${agentId}/skills/${key}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  accounts: (businessId, platform) => {
    const params = new URLSearchParams();
    if (businessId && businessId !== 'all') params.set('business_id', businessId);
    if (platform && platform !== 'all') params.set('platform', platform);
    return request(`/api/accounts?${params}`);
  },
  connectAccount: (body) =>
    request('/api/accounts', { method: 'POST', body: JSON.stringify(body) }),
  // Start the marketplace's own authorization. Comes back either with the
  // page to send the seller to, or with the reason it cannot and the fields
  // to ask for instead.
  authorizeAccount: (body) =>
    request('/api/accounts/authorize', { method: 'POST', body: JSON.stringify(body) }),
  updateAccount: (id, body) =>
    request(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  disconnectAccount: (id) => request(`/api/accounts/${id}`, { method: 'DELETE' }),

  products: (businessId, { platform, accountId } = {}) => {
    const params = new URLSearchParams();
    if (businessId && businessId !== 'all') params.set('business_id', businessId);
    if (accountId) params.set('account_id', accountId);
    else if (platform && platform !== 'all') params.set('platform', platform);
    return request(`/api/products?${params}`);
  },
  createProduct: (body) =>
    request('/api/products', { method: 'POST', body: JSON.stringify(body) }),
  editProduct: (id, body) =>
    request(`/api/products/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  listProduct: (id, accountIds) =>
    request(`/api/products/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify({ account_ids: accountIds }),
    }),
  deleteProduct: (id) => request(`/api/products/${id}`, { method: 'DELETE' }),

  // The lines a new office can be opened for, and opening one.
  businessLines: () => request('/api/business-lines'),
  openOffice: (body) =>
    request('/api/businesses', { method: 'POST', body: JSON.stringify(body) }),

  // The inbox. Marketplace chat and DMs; there is no call anywhere, because
  // none of these platforms has one.
  inbox: (businessId, channel = 'all') => {
    const params = new URLSearchParams();
    if (businessId && businessId !== 'all') params.set('business_id', businessId);
    if (channel && channel !== 'all') params.set('channel', channel);
    return request(`/api/inbox?${params}`);
  },
  thread: (id) => request(`/api/inbox/${id}`),
  replyToThread: (id, draft) =>
    request(`/api/inbox/${id}/reply`, { method: 'POST', body: JSON.stringify({ draft }) }),
  closeThread: (id) => request(`/api/inbox/${id}/close`, { method: 'POST' }),

  // Sales.
  orders: (businessId, { status, accountId, source } = {}) => {
    const params = new URLSearchParams();
    if (businessId && businessId !== 'all') params.set('business_id', businessId);
    if (status && status !== 'all') params.set('status', status);
    if (accountId) params.set('account_id', accountId);
    if (source && source !== 'all') params.set('source', source);
    return request(`/api/orders?${params}`);
  },
  moveOrder: (id, status) =>
    request(`/api/orders/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  chaseOrder: (id) => request(`/api/orders/${id}/chase`, { method: 'POST' }),

  // The money.
  payments: (businessId) => request(`/api/payments${scope(businessId)}`),
  payouts: (businessId) => request(`/api/payouts${scope(businessId)}`),
  paymentRules: (businessId) => request(`/api/payment-rules${scope(businessId)}`),
  editPaymentRule: (id, body) =>
    request(`/api/payment-rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // Live selling.
  live: (businessId, status = 'all') => {
    const params = new URLSearchParams();
    if (businessId && businessId !== 'all') params.set('business_id', businessId);
    if (status && status !== 'all') params.set('status', status);
    return request(`/api/live?${params}`);
  },
  liveSession: (id) => request(`/api/live/${id}`),
  bookLive: (body) => request('/api/live', { method: 'POST', body: JSON.stringify(body) }),
  fillBasket: (id, items) =>
    request(`/api/live/${id}/basket`, { method: 'POST', body: JSON.stringify({ items }) }),
  armLive: (id, replyTemplate) =>
    request(`/api/live/${id}/arm`, {
      method: 'POST',
      body: JSON.stringify(replyTemplate ? { reply_template: replyTemplate } : {}),
    }),
  pauseLive: (id, resume) =>
    request(`/api/live/${id}/pause`, { method: 'POST', body: JSON.stringify({ resume }) }),
  endLive: (id) => request(`/api/live/${id}/end`, { method: 'POST' }),

  platform: {
    overview: () => request('/api/platform/overview'),
    addBusiness: (body) =>
      request('/api/platform/businesses', { method: 'POST', body: JSON.stringify(body) }),
    setActive: (id, isActive) =>
      request(`/api/platform/businesses/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: isActive }),
      }),
    users: () => request('/api/platform/users'),
    addUser: (body) =>
      request('/api/platform/users', { method: 'POST', body: JSON.stringify(body) }),
  },
  kill: (agentId, resume) =>
    request(`/api/agents/${agentId}/kill`, {
      method: 'POST',
      body: JSON.stringify({ resume }),
    }),
};
