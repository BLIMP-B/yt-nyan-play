import { session } from 'electron';
import { browserUserAgent } from '../core/browser-user-agent.mjs';
import { validateMediaNavigation } from '../core/media-navigation.mjs';
import { APP_ICON } from './app-icon.mjs';

export function playbackSession() {
  const ses = session.fromPartition('persist:nyan-playback');
  ses.setUserAgent(browserUserAgent(ses.getUserAgent()));
  ses.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  return ses;
}
export function guardMediaWindow(window, source, getConfig, track = () => {}, externalLogin) {
  const googleLogin = destination => externalLogin && /(^|\.)youtube\.com$|^youtu\.be$/.test(new URL(source).hostname) && new URL(destination).hostname === 'accounts.google.com';
  const check = (event, destination) => {
    try { validateMediaNavigation(destination, getConfig().media.allowedHosts, source); } catch { event.preventDefault(); return; }
    if (googleLogin(destination)) { event.preventDefault(); void externalLogin().catch(() => {}); }
  };
  window.webContents.on('will-navigate', check);
  window.webContents.on('will-redirect', check);
  window.webContents.on('will-prevent-unload', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { validateMediaNavigation(url, getConfig().media.allowedHosts, source); } catch { return { action: 'deny' }; }
    if (googleLogin(url)) { void externalLogin().catch(() => {}); return { action: 'deny' }; }
    return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: {
      title: '再生アカウントにログイン', icon: APP_ICON, autoHideMenuBar: true,
      webPreferences: { session: window.webContents.session, contextIsolation: true, nodeIntegration: false, sandbox: true },
    } };
  });
  window.webContents.on('did-create-window', child => { track(child); guardMediaWindow(child, source, getConfig, track, externalLogin); });
}
