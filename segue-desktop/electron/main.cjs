const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const Database = require("better-sqlite3");
const chokidar = require("chokidar");
const fs = require("node:fs");
const path = require("node:path");

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg"]);
let mainWindow;
let database;
const watchers = new Map();

function databasePath() { return path.join(app.getPath("userData"), "segue.sqlite"); }

function initializeDatabase() {
  database = new Database(databasePath());
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS library_roots (
      path TEXT PRIMARY KEY,
      added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_scanned_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      extension TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      modified_at_ms INTEGER NOT NULL,
      file_hash TEXT,
      bpm REAL,
      musical_key TEXT,
      energy REAL,
      confidence REAL,
      beat_ticks_json TEXT,
      duration_seconds REAL,
      analysis_version TEXT,
      analyzed_at TEXT,
      analysis_status TEXT NOT NULL DEFAULT 'pending',
      missing INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS tracks_analysis_status_idx ON tracks(analysis_status);
  `);
  // An interrupted app cannot leave a track permanently locked in the active state.
  database.prepare("UPDATE tracks SET analysis_status = 'pending' WHERE analysis_status = 'analyzing'").run();
}

function notifyLibraryChanged() { mainWindow?.webContents.send("library:changed"); }
function isAudioFile(filePath) { return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()); }

const upsertTrack = (filePath) => {
  if (!isAudioFile(filePath) || !fs.existsSync(filePath)) return;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return;
  database.prepare(`
    INSERT INTO tracks (file_path, filename, extension, size_bytes, modified_at_ms, analysis_status, missing)
    VALUES (@filePath, @filename, @extension, @sizeBytes, @modifiedAtMs, 'pending', 0)
    ON CONFLICT(file_path) DO UPDATE SET
      filename = excluded.filename,
      extension = excluded.extension,
      missing = 0,
      analysis_status = CASE
        WHEN tracks.size_bytes != excluded.size_bytes OR tracks.modified_at_ms != excluded.modified_at_ms THEN 'pending'
        ELSE tracks.analysis_status
      END,
      size_bytes = excluded.size_bytes,
      modified_at_ms = excluded.modified_at_ms,
      updated_at = CURRENT_TIMESTAMP
  `).run({ filePath, filename: path.basename(filePath), extension: path.extname(filePath).toLowerCase(), sizeBytes: stat.size, modifiedAtMs: Math.floor(stat.mtimeMs) });
};

function markMissing(filePath) {
  database.prepare("UPDATE tracks SET missing = 1, updated_at = CURRENT_TIMESTAMP WHERE file_path = ?").run(filePath);
}

function walk(rootPath) {
  const files = [];
  const pending = [rootPath];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && isAudioFile(child)) files.push(child);
    }
  }
  return files;
}

function watchLibrary(rootPath) {
  if (watchers.has(rootPath)) return;
  const watcher = chokidar.watch(rootPath, { ignoreInitial: true, ignored: /(^|[\\/])\../ });
  watcher.on("add", (filePath) => { upsertTrack(filePath); notifyLibraryChanged(); });
  watcher.on("change", (filePath) => { upsertTrack(filePath); notifyLibraryChanged(); });
  watcher.on("unlink", (filePath) => { markMissing(filePath); notifyLibraryChanged(); });
  watchers.set(rootPath, watcher);
}

function scanLibrary(rootPath) {
  const files = walk(rootPath);
  const transaction = database.transaction((entries) => entries.forEach(upsertTrack));
  transaction(files);
  database.prepare("INSERT INTO library_roots (path, last_scanned_at) VALUES (?, CURRENT_TIMESTAMP) ON CONFLICT(path) DO UPDATE SET last_scanned_at = CURRENT_TIMESTAMP").run(rootPath);
  watchLibrary(rootPath);
  notifyLibraryChanged();
  return { rootPath, audioFilesFound: files.length };
}

function claimPendingAnalysis() {
  return database.transaction(() => {
    const track = database.prepare(`SELECT id, filename, file_path, extension, size_bytes FROM tracks
      WHERE missing = 0 AND analysis_status = 'pending' ORDER BY id LIMIT 1`).get();
    if (!track) return null;
    const claimed = database.prepare("UPDATE tracks SET analysis_status = 'analyzing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND analysis_status = 'pending'").run(track.id);
    return claimed.changes ? track : null;
  })();
}

function readTrackForAnalysis(id) {
  const track = database.prepare("SELECT file_path FROM tracks WHERE id = ? AND missing = 0").get(id);
  if (!track || !fs.existsSync(track.file_path)) throw new Error("Track is no longer available in the library.");
  return fs.readFileSync(track.file_path);
}

function completeTrackAnalysis(id, result) {
  const number = (value, name) => {
    if (!Number.isFinite(value)) throw new Error(`Invalid ${name} analysis result.`);
    return value;
  };
  const beatTicks = Array.isArray(result.beatTicks) ? result.beatTicks.filter(Number.isFinite) : [];
  const changed = database.prepare(`UPDATE tracks SET bpm = ?, musical_key = ?, energy = ?, confidence = ?,
    beat_ticks_json = ?, duration_seconds = ?, analysis_version = ?, analyzed_at = CURRENT_TIMESTAMP,
    analysis_status = 'analyzed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND analysis_status = 'analyzing'`).run(
    number(result.bpm, "BPM"), String(result.musicalKey || "Unknown"), number(result.energy, "energy"),
    number(result.confidence, "confidence"), JSON.stringify(beatTicks), number(result.durationSeconds, "duration"),
    "essentia.js-0.1.3", id,
  );
  if (!changed.changes) throw new Error("Track was no longer claimed for analysis.");
  notifyLibraryChanged();
}

function failTrackAnalysis(id) {
  database.prepare("UPDATE tracks SET analysis_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND analysis_status = 'analyzing'").run(id);
  notifyLibraryChanged();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  if (process.env.SEGUE_DEV_SERVER_URL) mainWindow.loadURL(process.env.SEGUE_DEV_SERVER_URL);
  else mainWindow.loadFile(path.join(__dirname, "..", "dist", "segue-desktop", "browser", "index.html"));
}

app.whenReady().then(() => {
  initializeDatabase();
  ipcMain.handle("library:choose-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    return scanLibrary(result.filePaths[0]);
  });
  ipcMain.handle("library:scan", (_event, rootPath) => scanLibrary(rootPath));
  ipcMain.handle("library:list-roots", () => database.prepare("SELECT path, added_at, last_scanned_at FROM library_roots ORDER BY added_at DESC").all());
  ipcMain.handle("library:list-tracks", () => database.prepare(`SELECT id, filename, file_path, extension, size_bytes, bpm, musical_key, energy, confidence, analysis_status, missing, analyzed_at FROM tracks WHERE missing = 0 ORDER BY filename COLLATE NOCASE`).all());
  ipcMain.handle("analysis:claim-next", () => claimPendingAnalysis());
  ipcMain.handle("analysis:read-track", (_event, id) => readTrackForAnalysis(id));
  ipcMain.handle("analysis:complete", (_event, id, result) => completeTrackAnalysis(id, result));
  ipcMain.handle("analysis:failed", (_event, id) => failTrackAnalysis(id));
  ipcMain.handle("analysis:retry-failed", () => {
    const result = database.prepare("UPDATE tracks SET analysis_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE missing = 0 AND analysis_status = 'failed'").run();
    if (result.changes) notifyLibraryChanged();
    return result.changes;
  });
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { for (const watcher of watchers.values()) watcher.close(); database?.close(); });
