/**
 * A thin, always-present stand-in for the desktop bridge.
 *
 * In the packaged application `window.tms` exists (see src/main/preload.js). When
 * the interface is opened in a plain browser -- which happens during development
 * and when a colleague on the LAN opens the host machine's address -- it does
 * not, so every call falls back to something a browser can do: an anchor
 * download instead of a Save dialog, a file input instead of an Open dialog,
 * window.confirm instead of an OS dialog.
 *
 * Pages therefore never test for Electron. They just call desktop.saveFile().
 */

const bridge = typeof window !== 'undefined' && window.tms ? window.tms : null;

export const isDesktop = !!(bridge && bridge.isDesktop);

// ---------------------------------------------------------------------------
// Base64 helpers (binary downloads arrive as base64 from the desktop bridge and
// as a Blob from fetch, and both have to end up in the same place)
// ---------------------------------------------------------------------------
export function base64ToBlob(base64, mime = 'application/octet-stream') {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;   // build in chunks; String.fromCharCode has an argument limit
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function browserDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the URL is dropped.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { saved: true, path: filename, browser: true };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------
const desktop = {
  isDesktop,

  async getRuntime() {
    if (bridge) return bridge.getRuntime();
    // A browser tab: the API is served from the same origin that served this page.
    return {
      apiBase: `${window.location.origin}/api`,
      mode: 'BROWSER',
      local: false,
      hostUrl: window.location.origin,
      databasePath: null,
      driver: null,
      version: null,
      name: 'University Timetable Management',
      platform: 'browser',
      isDev: false,
      startupError: null,
    };
  },

  async getPaths() {
    if (bridge) return bridge.getPaths();
    return null;
  },

  /**
   * Save As. Pass either `blob`, `data` (base64) or `text`.
   * @returns {Promise<{saved:boolean, path?:string, cancelled?:boolean}>}
   */
  async saveFile({ filename, blob, data, text, kind, title, mime } = {}) {
    if (bridge) {
      let payload = { filename, kind, title };
      if (blob) payload.data = await blobToBase64(blob);
      else if (data != null) payload.data = data;
      else payload.text = text;
      return bridge.saveFile(payload);
    }
    const outBlob = blob
      || (data != null ? base64ToBlob(data, mime) : new Blob([String(text ?? '')], { type: mime || 'text/plain;charset=utf-8' }));
    return browserDownload(filename, outBlob);
  },

  /**
   * Open a file. Resolves to { opened, name, bytes, data } where data is base64,
   * or { opened:false, cancelled:true }.
   */
  async openFile({ kind, accept, title, maxBytes } = {}) {
    if (bridge) return bridge.openFile({ kind, title, maxBytes });

    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      input.style.display = 'none';
      document.body.appendChild(input);

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(value);
      };

      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return finish({ opened: false, cancelled: true });
        const limit = Number(maxBytes) > 0 ? Number(maxBytes) : 64 * 1024 * 1024;
        if (file.size > limit) {
          return finish({
            opened: false,
            error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB, larger than the `
              + `${(limit / 1024 / 1024).toFixed(0)} MB limit.`,
          });
        }
        finish({
          opened: true,
          path: file.name,
          name: file.name,
          bytes: file.size,
          data: await blobToBase64(file),
        });
      });
      // A cancelled file dialog fires nothing in most browsers, so the promise is
      // released when focus comes back to the window.
      window.addEventListener('focus', () => {
        setTimeout(() => {
          if (!input.files || !input.files.length) finish({ opened: false, cancelled: true });
        }, 500);
      }, { once: true });

      input.click();
    });
  },

  /**
   * Turns the export endpoint's print-ready HTML into a PDF. Only Electron can
   * do this properly; a browser gets the print dialog instead.
   */
  async printToPdf({ html, filename, landscape } = {}) {
    if (bridge) return bridge.printToPdf({ html, filename, landscape });

    const frame = document.createElement('iframe');
    frame.style.position = 'fixed';
    frame.style.right = '100%';
    frame.style.width = '1024px';
    frame.style.height = '768px';
    document.body.appendChild(frame);
    frame.srcdoc = html;
    await new Promise((resolve) => { frame.onload = resolve; });
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 2000);
    return { saved: false, printed: true, browser: true };
  },

  async reveal(target) {
    if (bridge) return bridge.reveal(target);
    return { revealed: null };
  },

  async openExternal(url) {
    if (bridge) return bridge.openExternal(url);
    window.open(url, '_blank', 'noopener,noreferrer');
    return { opened: true };
  },

  async getInstallation() {
    if (bridge) return bridge.getInstallation();
    return null;
  },

  async probeHost(hostUrl) {
    if (bridge) return bridge.probeHost(hostUrl);
    return { ok: false, message: 'Switching host machines is only possible in the installed application.' };
  },

  async setInstallation(cfg) {
    if (bridge) return bridge.setInstallation(cfg);
    throw new Error('The installation mode can only be changed in the installed application.');
  },

  async restart() {
    if (bridge) return bridge.restart();
    window.location.reload();
    return { restarting: true };
  },

  /** OS-drawn confirmation for destructive actions; window.confirm in a browser. */
  async confirm(opts = {}) {
    if (bridge) return bridge.confirm(opts);
    const message = [opts.message, opts.detail].filter(Boolean).join('\n\n');
    // eslint-disable-next-line no-alert
    return { confirmed: window.confirm(message || 'Are you sure?') };
  },

  /**
   * Menu commands arrive over IPC in Electron. Returns an unsubscribe function;
   * in a browser there is no menu, so it is a no-op and the app shell needs no
   * branch of its own.
   */
  onMenuCommand(handler) {
    if (bridge && typeof bridge.onMenuCommand === 'function') {
      return bridge.onMenuCommand(handler);
    }
    return () => {};
  },
};

export default desktop;
