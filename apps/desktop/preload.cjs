const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('nyan', {
  invoke: (action, data) => ipcRenderer.invoke('nyan:action', action, data),
  subscribe: callback => subscribe('nyan:state', callback),
  onAudio: callback => subscribe('nyan:audio', callback),
  audioResult: data => ipcRenderer.send('nyan:audio-result', data),
  pcm: (id, bytes) => ipcRenderer.send('nyan:pcm', id, bytes),
});
