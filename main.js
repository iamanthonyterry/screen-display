const { app, BrowserWindow, session, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const ALLOWED = new Set(['media', 'midi', 'midiSysex', 'fullscreen']);

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'Screen Display',
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
}

function sendStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('updater:status', s);
}

function setupUpdater() {
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendStatus({ state: 'checking' }));
  autoUpdater.on('update-available', i => sendStatus({ state: 'downloading', version: i.version }));
  autoUpdater.on('update-not-available', () => sendStatus({ state: 'current' }));
  autoUpdater.on('download-progress', p => sendStatus({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', i => sendStatus({ state: 'ready', version: i.version }));
  autoUpdater.on('error', e => sendStatus({ state: 'error', message: String(e && e.message || e) }));

  ipcMain.handle('updater:version', () => app.getVersion());
  ipcMain.handle('updater:check', () => {
    if (!app.isPackaged) return sendStatus({ state: 'dev' });
    autoUpdater.checkForUpdates().catch(() => {});
  });
  ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall());

  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ALLOWED.has(perm));
  setupUpdater();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
