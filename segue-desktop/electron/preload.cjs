const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("segue", {
  chooseLibraryFolder: () => ipcRenderer.invoke("library:choose-folder"),
  scanLibrary: (rootPath) => ipcRenderer.invoke("library:scan", rootPath),
  listLibraryRoots: () => ipcRenderer.invoke("library:list-roots"),
  listTracks: () => ipcRenderer.invoke("library:list-tracks"),
  claimPendingAnalysis: () => ipcRenderer.invoke("analysis:claim-next"),
  readTrackForAnalysis: async (id) => {
    const bytes = await ipcRenderer.invoke("analysis:read-track", id);
    return new Uint8Array(bytes).buffer;
  },
  completeTrackAnalysis: (id, result) => ipcRenderer.invoke("analysis:complete", id, result),
  failTrackAnalysis: (id) => ipcRenderer.invoke("analysis:failed", id),
  retryFailedAnalysis: () => ipcRenderer.invoke("analysis:retry-failed"),
  onLibraryChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("library:changed", listener);
    return () => ipcRenderer.removeListener("library:changed", listener);
  },
});
