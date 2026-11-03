const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, value) => ipcRenderer.invoke(`desktop:${name}`, value);
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  getState: () => invoke('state'),
  enterChat: () => invoke('enter'),
  showChat: page => invoke('show', page),
  openSettings: section => invoke('settings', section),
  hidePet: () => invoke('pet-hide'),
  showPet: () => invoke('pet-show'),
  movePet: delta => invoke('pet-move', delta),
  setPetInteractive: enabled => invoke('pet-interactive', enabled),
  setPetRegions: regions => invoke('pet-regions', regions),
  setPetSettings: settings => invoke('pet-settings', settings),
  setWallpaperEnabled: enabled => invoke('wallpaper', enabled),
  setWallpaperSettings: settings => invoke('wallpaper-settings', settings),
  setRecordingShortcut: shortcut => invoke('shortcut', shortcut),
  setVoiceEnabled: enabled => invoke('voice', enabled),
  minimize: () => invoke('minimize'),
  toggleMaximize: () => invoke('toggle-maximize'),
  close: () => invoke('hide'),
  quit: () => invoke('quit'),
  onEvent: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('desktop:event', listener);
    return () => ipcRenderer.removeListener('desktop:event', listener);
  },
  on: (type, callback) => {
    if (typeof type !== 'string' || typeof callback !== 'function') return () => {};
    const listener = (_event, value) => { if (value.type === type) callback(value); };
    ipcRenderer.on('desktop:event', listener);
    return () => ipcRenderer.removeListener('desktop:event', listener);
  }
}));
