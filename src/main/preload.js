'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('tokkie', {
  getState: () => ipcRenderer.invoke('state'),
  estimate: (text) => ipcRenderer.invoke('estimate', text),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setup: { status: () => ipcRenderer.invoke('setup:status'), connect: () => ipcRenderer.invoke('setup:connect'), disconnect: () => ipcRenderer.invoke('setup:disconnect') },
  sources: () => ipcRenderer.invoke('sources'),
  setReading: (id, pct) => ipcRenderer.invoke('usage:setReading', id, pct),
  onState: on('state'), onEstimate: on('estimate'), onCommand: on('command'), onCursor: on('cursor'),
  ui: {
    layout: (l) => ipcRenderer.invoke('ui:layout', l),
    dragStart: () => ipcRenderer.send('ui:dragStart'),
    dragMove: (d) => ipcRenderer.send('ui:dragMove', d),
    dragEnd: () => ipcRenderer.send('ui:dragEnd'),
    interactive: (v) => ipcRenderer.send('ui:interactive', !!v),
    quit: () => ipcRenderer.send('ui:quit'),
    hide: () => ipcRenderer.send('ui:hide'),
    openExternal: (u) => ipcRenderer.send('ui:openExternal', u),
    revealSettings: () => ipcRenderer.send('ui:revealSettings'),
    estimateClipboard: () => ipcRenderer.send('ui:estimateClipboard'),
    ready: () => ipcRenderer.send('ui:ready'),
    band: (b) => ipcRenderer.send('ui:band', b),
    openSession: (id) => ipcRenderer.invoke('ui:openSession', id),
    copyText: (t) => ipcRenderer.invoke('ui:copyText', t),
    promptText: (sid, uuid) => ipcRenderer.invoke('run:prompt', sid, uuid),
    history: () => ipcRenderer.invoke('runs:history'),
  },
});
