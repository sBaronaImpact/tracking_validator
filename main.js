'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const https = require('https');

const REPO_OWNER = 'sBaronaImpact';
const REPO_NAME  = 'tracking_validator';

// ── Config persistence ─────────────────────────────────────────────────────────
const CONFIG_PATH    = path.join(app.getPath('userData'), 'tv-config.json');
const DEFAULT_CONFIG = {
  concurrency:   2,
  waitTime:      20000,
  retryCount:    1,
  interUrlDelay: 2000,
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch { return { ...DEFAULT_CONFIG }; }
}

function saveConfig(config) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch { /* ignore */ }
}

// ── Update check ───────────────────────────────────────────────────────────────
// Checks the GitHub Releases API for a newer version.
// No silent install — just notifies the user and links to the release page.
function checkForUpdates(win) {
  const url     = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
  const options = { headers: { 'User-Agent': 'tracking-validator-app', 'Accept': 'application/vnd.github+json' } };

  https.get(url, options, res => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      try {
        const release  = JSON.parse(data);
        const latest   = (release.tag_name || '').replace(/^v/, '');
        const current  = app.getVersion();
        if (latest && latest !== current && isNewer(latest, current)) {
          win.webContents.send('update:available', { version: latest, url: release.html_url });
        }
      } catch { /* ignore parse errors */ }
    });
  }).on('error', () => { /* ignore network errors — update check is best-effort */ });
}

function isNewer(latest, current) {
  const parse = v => v.split('.').map(Number);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

// ── Window ─────────────────────────────────────────────────────────────────────
let mainWindow   = null;
let activeCrawler = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1440,
    height:          900,
    minWidth:        960,
    minHeight:       640,
    backgroundColor: '#090b10',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false, // needed for require() in preload
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Check for updates 3 seconds after launch (non-blocking)
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => checkForUpdates(mainWindow), 3000);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC ────────────────────────────────────────────────────────────────────────

ipcMain.handle('config:get', ()       => loadConfig());
ipcMain.handle('config:set', (_, cfg) => { saveConfig(cfg); return true; });
ipcMain.handle('app:version',  ()     => app.getVersion());
ipcMain.handle('shell:open', (_, url) => shell.openExternal(url));

ipcMain.handle('dialog:open-csv', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:      'Open Input CSV',
    filters:    [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  return fs.readFileSync(filePaths[0], 'utf8');
});

ipcMain.handle('crawl:start', async (_, { urls, config }) => {
  if (activeCrawler) return { error: 'Crawl already running' };

  let Crawler;
  try { ({ Crawler } = require('./engine/crawler')); }
  catch (e) { return { error: e.message }; }

  activeCrawler = new Crawler(
    config,
    msg    => mainWindow?.webContents.send('crawl:log',    msg),
    result => mainWindow?.webContents.send('crawl:result', sanitize(result)),
    (id, update) => mainWindow?.webContents.send('identity:update', { id, update }),
    ()     => mainWindow?.webContents.send('crawl:done'),
    ()     => mainWindow?.webContents.send('identity:done'),
  );

  activeCrawler.run(urls).finally(() => { activeCrawler = null; });
  return { ok: true };
});

ipcMain.handle('crawl:cancel', () => {
  if (activeCrawler) activeCrawler.cancel();
  return { ok: true };
});

// Strip internal _raw before sending over IPC
function sanitize(result) {
  const { _raw, ...rest } = result;
  return rest;
}
