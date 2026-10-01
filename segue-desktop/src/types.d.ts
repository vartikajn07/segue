interface LibraryRoot { path: string; added_at: string; last_scanned_at: string | null; }
interface TrackSummary {
  id: number; filename: string; file_path: string; extension: string; size_bytes: number;
  bpm: number | null; musical_key: string | null; energy: number | null; confidence: number | null;
  analysis_status: "pending" | "analyzing" | "analyzed" | "failed"; missing: number; analyzed_at: string | null;
}
interface PendingAnalysisTrack { id: number; filename: string; file_path: string; extension: string; size_bytes: number; }
interface AnalysisResult {
  bpm: number; musicalKey: string; energy: number; confidence: number;
  beatTicks: number[]; durationSeconds: number;
}
interface Window {
  segue: {
    chooseLibraryFolder(): Promise<{ rootPath: string; audioFilesFound: number } | null>;
    scanLibrary(rootPath: string): Promise<{ rootPath: string; audioFilesFound: number }>;
    listLibraryRoots(): Promise<LibraryRoot[]>;
    listTracks(): Promise<TrackSummary[]>;
    claimPendingAnalysis(): Promise<PendingAnalysisTrack | null>;
    readTrackForAnalysis(id: number): Promise<ArrayBuffer>;
    completeTrackAnalysis(id: number, result: AnalysisResult): Promise<void>;
    failTrackAnalysis(id: number): Promise<void>;
    retryFailedAnalysis(): Promise<number>;
    onLibraryChanged(callback: () => void): () => void;
  };
}
