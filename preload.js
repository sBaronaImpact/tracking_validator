'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // App
  getVersion:   ()      => ipcRenderer.invoke('app:version'),
  rendererReady:()      => ipcRenderer.send('renderer:ready'),

  // Config
  getConfig:  ()      => ipcRenderer.invoke('config:get'),
  setConfig:  (cfg)   => ipcRenderer.invoke('config:set', cfg),

  // File
  openCsv:    ()      => ipcRenderer.invoke('dialog:open-csv'),

  // Crawl
  startCrawl:   (urls, config) => ipcRenderer.invoke('crawl:start', { urls, config }),
  cancelCrawl:  ()             => ipcRenderer.invoke('crawl:cancel'),
  stopIdentity: ()             => ipcRenderer.invoke('identity:stop'),

  // Event streams (main → renderer)
  onLog:             fn => ipcRenderer.on('crawl:log',       (_, v) => fn(v)),
  onResult:          fn => ipcRenderer.on('crawl:result',    (_, v) => fn(v)),
  onDone:            fn => ipcRenderer.on('crawl:done',      ()     => fn()),
  onIdentityUpdate:  fn => ipcRenderer.on('identity:update', (_, v) => fn(v.id, v.update)),
  onIdentityDone:    fn => ipcRenderer.on('identity:done',   ()     => fn()),
  onUpdateAvailable: fn => ipcRenderer.on('update:available',(_, v) => fn(v)),

  // Mobile crawl
  startMobileCrawl: (urls, config) => ipcRenderer.invoke('mobile:start', { urls, config }),
  cancelMobileCrawl: ()            => ipcRenderer.invoke('mobile:cancel'),
  onMobileResult:    fn => ipcRenderer.on('mobile:result', (_, v) => fn(v)),
  onMobileDone:      fn => ipcRenderer.on('mobile:done',   ()     => fn()),

  // Cleanup
  off: channel => ipcRenderer.removeAllListeners(channel),

  // External links
  openExternal: url => ipcRenderer.invoke('shell:open', url),
});