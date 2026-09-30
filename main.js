const { app, BrowserWindow, session, globalShortcut } = require('electron');
const path = require('path');

const ALLOWED = new Set(['media', 'midi', 'midiSysex', 'fullscreen']);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'Screen Display',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ALLOWED.has(perm));
  createWindow();
});

app.on('window-all-closed', () => app.quit());
