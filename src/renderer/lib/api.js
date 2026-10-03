import desktop from './desktop.js';

/**
 * The one place the interface talks to the backend.
 *
 * Everything the rest of the renderer needs from HTTP lives here:
 *   - the API base address, discovered once at start-up (local, LAN host, or the
 *     origin that served this page)
 *   - the bearer token, and the active college header that goes with it
 *   - unpacking the server's single error shape into a real Error, keeping the
 *     fields pages act on: details, violations, canOverride, overrideHint, report
 *
 * Nothing else in the renderer calls fetch().
 */

let apiBase = '/api';
let token = null;
let activeCollegeId = null;
let onUnauthorised = null;

const TOKEN_KEY = 'tms.token';
const COLLEGE_KEY = 'tms.activeCollege';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
export function setApiBase(base) {
  if (base) apiBase = String(base).replace(/\/+$/, '');
}

export function getApiBase() {
  return apiBase;
}

export function setToken(value) {
  token = value || null;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private-mode browsers refuse storage; the session simply will not survive
    // a reload, which is not worth failing over.
  }
}

export function getToken() {
  if (token) return token;
  try {
    token = window.localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    token = null;
  }
  return token;
}

/**
 * The Super Admin's college switcher. Sent as a header so the server -- not the
 * interface -- decides whether this user may look at that college at all.
 */
export function setActiveCollege(id) {
  activeCollegeId = id == null || id === '' ? null : Number(id);
  try {
    if (activeCollegeId) window.localStorage.setItem(COLLEGE_KEY, String(activeCollegeId));
    else window.localStorage.removeItem(COLLEGE_KEY);
  } catch { /* see setToken */ }
}

export function getActiveCollege() {
  if (activeCollegeId != null) return activeCollegeId;
  try {
    const stored = window.localStorage.getItem(COLLEGE_KEY);
    activeCollegeId = stored ? Number(stored) : null;
  } catch {
    activeCollegeId = null;
  }
  return activeCollegeId;
}

/** Called when the server rejects the token, so the shell can return to sign-in. */
export function setUnauthorisedHandler(fn) {
  onUnauthorised = fn;
}

/** Discovers the API address. Safe to call more than once. */
export async function initApi() {
  const runtime = await desktop.getRuntime();
  if (runtime && runtime.apiBase) setApiBase(runtime.apiBase);
  getToken();
  getActiveCollege();
  return runtime;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.isApiError = true;
    Object.assign(this, extra);
  }
}

/**
 * True when the server refused a hard conflict but said the coordinator is
 * allowed to do it anyway. Pages use this to offer "Do it anyway".
 */
export const canOverride = (err) => !!(err && err.canOverride);

/** A one-line summary suitable for a toast, including field-level detail. */
export function describeError(err) {
  if (!err) return 'Something went wrong.';
  const parts = [err.message || 'Something went wrong.'];
  if (Array.isArray(err.details) && err.details.length) {
    parts.push(err.details.map((d) => (typeof d === 'string' ? d : `${d.field || d.key || ''} ${d.message || ''}`.trim())).join('; '));
  }
  if (Array.isArray(err.violations) && err.violations.length) {
    parts.push(err.violations.map((v) => (typeof v === 'string' ? v : v.message || v.rule || '')).filter(Boolean).join('; '));
  }
  return parts.filter(Boolean).join(' — ');
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
function buildUrl(path, query) {
  const clean = String(path || '').startsWith('/') ? path : `/${path}`;
  let url = `${apiBase}${clean}`;
  if (query && typeof query === 'object') {
    const search = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (Array.isArray(value)) value.forEach((v) => search.append(key, String(v)));
      else search.append(key, String(value));
    });
    const qs = search.toString();
    if (qs) url += `${url.includes('?') ? '&' : '?'}${qs}`;
  }
  return url;
}

function headers(extra = {}) {
  const out = { Accept: 'application/json', ...extra };
  const bearer = getToken();
  if (bearer) out.Authorization = `Bearer ${bearer}`;
  const college = getActiveCollege();
  if (college) out['X-Active-College'] = String(college);
  return out;
}

async function unpackError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const message = (body && body.message)
    || (res.status === 404 ? 'That was not found.' : `The request failed (status ${res.status}).`);
  const err = new ApiError(message, {
    status: res.status,
    code: (body && body.code) || `HTTP_${res.status}`,
  });
  if (body) {
    // Keep exactly the fields the server documents, so pages can rely on them.
    if (body.details) err.details = body.details;
    if (body.violations) err.violations = body.violations;
    if (body.canOverride) {
      err.canOverride = true;
      err.overrideHint = body.overrideHint || null;
    }
    if (body.report) err.report = body.report;
    if (body.aiStatus) err.aiStatus = body.aiStatus;
    if (body.readiness) err.readiness = body.readiness;
  }
  return err;
}

/**
 * @param {string} method
 * @param {string} path e.g. '/entities/faculty'
 * @param {object} [options] { body, query, signal, raw, timeoutMs }
 */
async function request(method, path, options = {}) {
  const { body, query, signal, raw, timeoutMs } = options;
  const controller = new AbortController();
  // The AI Assistant's call reaches OpenAI and back, so it is given far longer
  // than an ordinary local query.
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000;
  const timer = setTimeout(() => controller.abort(), limit);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const init = { method, signal: controller.signal, headers: headers() };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(buildUrl(path, query), init);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new ApiError('That took too long and was stopped.', { code: 'TIMEOUT' });
    }
    throw new ApiError(
      'The timetable service could not be reached. If this machine uses a shared database, '
      + 'check that the host machine is switched on.',
      { code: 'OFFLINE', cause: err }
    );
  }
  clearTimeout(timer);

  if (res.status === 401 && onUnauthorised) {
    const err = await unpackError(res);
    onUnauthorised(err);
    throw err;
  }
  if (!res.ok) throw await unpackError(res);
  if (raw) return res;
  if (res.status === 204) return null;

  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) return res.json();
  return res.text();
}

export const api = {
  get: (path, query, options) => request('GET', path, { ...options, query }),
  post: (path, body, options) => request('POST', path, { ...options, body }),
  put: (path, body, options) => request('PUT', path, { ...options, body }),
  patch: (path, body, options) => request('PATCH', path, { ...options, body }),
  del: (path, body, options) => request('DELETE', path, { ...options, body }),

  /** For the export and template endpoints, which answer with a file. */
  raw: (path, query, options) => request('GET', path, { ...options, query, raw: true }),
};

/**
 * Downloads a file from the API and hands it to the user.
 *
 * PDF is the one special case: the server returns print-ready HTML and the
 * desktop shell renders it, because a browser engine is already present and a
 * PDF library is not.
 */
export async function downloadFrom(path, { filename, kind, query, landscape } = {}) {
  const res = await api.raw(path, query);

  if (kind === 'pdf') {
    const html = await res.text();
    return desktop.printToPdf({ html, filename: filename || 'timetable.pdf', landscape });
  }

  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = filename || (match ? decodeURIComponent(match[1]) : 'download');
  return desktop.saveFile({ filename: name, blob, kind, mime: blob.type });
}

export default api;
