import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { startServer, stopServer } from '../server/index.js';

let mainWindow;
let server;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const portableDirectory = process.env.PORTABLE_EXECUTABLE_DIR;
    process.env.COPEAU_DATA_DIR = portableDirectory
      ? path.join(portableDirectory, 'data')
      : path.join(app.getPath('userData'), 'data');

    try {
      server = await startServer({
        port: 0,
        host: '127.0.0.1',
        threeAddonsDir: path.join(process.resourcesPath, 'three-addons'),
      });
      const address = server.address();
      mainWindow = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 960,
        minHeight: 640,
        title: 'Copeau',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await mainWindow.loadURL(`http://127.0.0.1:${address.port}`);
    } catch (error) {
      dialog.showErrorBox('Copeau — erreur de démarrage', error.message);
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (!server || quitting) return;
    event.preventDefault();
    quitting = true;
    stopServer()
      .catch((error) => console.error('Erreur à la fermeture du serveur :', error))
      .finally(() => app.quit());
  });
}
