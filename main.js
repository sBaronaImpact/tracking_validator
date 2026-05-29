'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

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

ipcMain.handle('shell:open', (_, url) => shell.openExternal(url));

// Strip internal _raw before sending over IPC
function sanitize(result) {
  const { _raw, ...rest } = result;
  return rest;
}
