'use strict';

/**
 * Prepares electron-builder's tool cache so that `npm run dist` works on an
 * ordinary Windows account.
 *
 * electron-builder fetches a package of Windows build tools called winCodeSign
 * -- it needs `rcedit-x64.exe` from it to stamp the icon and version strings
 * onto the built .exe, whether or not anything is code-signed. That archive also
 * carries the macOS half of the toolchain, and those files are *symlinks*.
 * Creating a symlink on Windows requires either an elevated shell or Developer
 * Mode, so on a normal account the extraction fails:
 *
 *     ERROR: Cannot create symbolic link : A required privilege is not held by
 *     the client. : ...\winCodeSign\<tmp>\darwin\10.12\lib\libcrypto.dylib
 *     ⨯ cannot execute  cause=exit status 2
 *
 * The build then dies, having got nowhere, and retries three times.
 *
 * None of those macOS files are used when building for Windows, so this fetches
 * the same archive and unpacks it without the `darwin` folder, into the exact
 * place electron-builder looks. electron-builder finds a populated cache and
 * never extracts anything itself.
 *
 * If any of it fails this exits quietly with a warning rather than an error: the
 * build is still worth attempting, and on a machine with Developer Mode enabled
 * it will simply succeed the ordinary way.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

// Pinned deliberately: this is the version electron-builder 25 asks for. If a
// future electron-builder wants a different one it will download that itself,
// and this step becomes a no-op that costs nothing.
const VERSION = '2.6.0';
const NAME = `winCodeSign-${VERSION}`;
const URL = 'https://github.com/electron-userland/electron-builder-binaries/releases/download'
  + `/${NAME}/${NAME}.7z`;

const say = (...parts) => console.log('  •', ...parts);

if (process.platform !== 'win32') {
  process.exit(0);
}

function cacheRoot() {
  if (process.env.ELECTRON_BUILDER_CACHE) return process.env.ELECTRON_BUILDER_CACHE;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'electron-builder', 'Cache');
}

const target = path.join(cacheRoot(), 'winCodeSign', NAME);

// rcedit is the file the build actually reaches for, so its presence -- not the
// directory's -- is what "already prepared" means.
if (fs.existsSync(path.join(target, 'rcedit-x64.exe'))) {
  say(`build tools ready  ${NAME}`);
  process.exit(0);
}

function sevenZip() {
  try {
    // A transitive dependency of electron-builder; it ships the 7za we need.
    return require('7zip-bin').path7za;
  } catch {
    return null;
  }
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('too many redirects')); return; }
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  const zip = sevenZip();
  if (!zip || !fs.existsSync(zip)) {
    say('7za was not found; leaving the tool cache to electron-builder');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-tools-'));
  const archive = path.join(tmp, `${NAME}.7z`);

  try {
    say(`preparing Windows build tools  ${NAME}`);
    await download(URL, archive);

    fs.mkdirSync(target, { recursive: true });
    const result = spawnSync(zip, ['x', archive, `-o${target}`, '-x!darwin', '-y'], {
      stdio: 'ignore',
    });
    if (result.status !== 0 || !fs.existsSync(path.join(target, 'rcedit-x64.exe'))) {
      throw new Error(`7za exited with ${result.status}`);
    }
    say(`build tools ready  ${target}`);
  } catch (err) {
    // Leave nothing half-extracted behind: a partial directory would look
    // "already prepared" to the check above and to electron-builder.
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* nothing there */ }
    say(`could not prepare the tool cache (${err.message}); continuing anyway`);
    say('if the build fails on "Cannot create symbolic link", enable Windows');
    say('Developer Mode or run the build from an elevated terminal');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  }
})();
