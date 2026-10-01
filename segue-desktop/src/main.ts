import "zone.js";
import { bootstrapApplication } from "@angular/platform-browser";
import { Component, OnDestroy, OnInit, signal } from "@angular/core";

@Component({
  selector: "app-root", standalone: true,
  template: `
    <main>
      <header class="app-header"><div><p class="eyebrow">LOCAL MUSIC, SMARTER PLAYBACK</p><h1>segue</h1><p>Build a queue now. Playback and automatic transitions land on this surface next.</p></div><div class="header-actions"><button class="secondary" (click)="chooseFolder()" [disabled]="busy()">Choose music folder</button>@if (failedCount()) {<button class="text-button retry" (click)="retryFailed()">Retry {{ failedCount() }} failed</button>}</div></header>
      <p class="status-line" aria-live="polite">{{ status() }}</p>
      @if (analysisTrackName()) { <p class="analysis-progress">Analyzing: {{ analysisTrackName() }}</p> }
      @if (roots().length) { <p class="root">Watching: {{ roots()[0].path }}</p> }
      <section class="summary"><div><strong>{{ tracks().length }}</strong><span>tracks in library</span></div><div><strong>{{ queue().length }}</strong><span>tracks in queue</span></div><div><strong>{{ pendingCount() }}</strong><span>awaiting analysis</span></div></section>
      <section class="workspace">
        <section class="panel library"><div class="panel-heading"><div><h2>Library</h2><span>Add tracks to build a listening queue.</span></div><label class="search"><span class="sr-only">Search library</span><input #searchInput type="search" placeholder="Search tracks" (input)="setSearch(searchInput.value)" /></label></div>
          @if (tracks().length) {<div class="track-list">@for (track of filteredTracks(); track track.id) {<article class="track-row"><div class="track-copy"><strong>{{ track.filename }}</strong><small>{{ track.extension.replace('.', '').toUpperCase() }} · {{ analysisLabel(track) }}</small></div><button class="icon-button" (click)="addToQueue(track)" [disabled]="isQueued(track.id)">{{ isQueued(track.id) ? 'Added' : '+ Queue' }}</button></article>} @empty {<p class="empty">No tracks match “{{ searchQuery() }}”.</p>}</div>} @else {<p class="empty">Choose a local folder to create your library index. Audio files never leave your computer.</p>}
        </section>
        <aside class="right-column"><section class="panel queue-panel"><div class="panel-heading compact"><div><h2>Queue</h2><span>{{ queue().length ? 'Drag-and-drop ordering comes next.' : 'Add tracks from your library.' }}</span></div>@if (queue().length) {<button class="text-button" (click)="clearQueue()">Clear</button>}</div>@if (queue().length) {<ol class="queue-list">@for (track of queue(); track track.id; let index = $index) {<li [class.current]="currentTrackId() === track.id"><span class="queue-index">{{ index + 1 }}</span><button class="queue-track" (click)="cueTrack(track)">{{ track.filename }}</button><button class="remove" (click)="removeFromQueue(track.id)">×</button></li>}</ol>} @else {<p class="empty queue-empty">Your queue is empty.</p>}</section>
          <section class="panel now-playing"><div class="now-label">NOW PLAYING</div>@if (currentTrack(); as track) {<div class="album-art" aria-hidden="true">♪</div><strong>{{ track.filename }}</strong><small>{{ track.extension.replace('.', '').toUpperCase() }} · queued track</small><div class="playback-note">Cued for playback. The Phase 3 audio engine will connect here.</div>} @else {<div class="album-art muted" aria-hidden="true">♪</div><strong>Nothing selected</strong><small>Choose a track from the queue to cue it.</small>}</section>
        </aside>
      </section>
    </main>`,
})
export class AppComponent implements OnInit, OnDestroy {
  readonly tracks = signal<TrackSummary[]>([]); readonly roots = signal<LibraryRoot[]>([]); readonly queue = signal<TrackSummary[]>([]); readonly searchQuery = signal(""); readonly currentTrackId = signal<number | null>(null); readonly busy = signal(false); readonly status = signal("Choose a folder to begin."); readonly analysisTrackName = signal<string | null>(null); private unsubscribe?: () => void; private analysisInFlight = false; private readonly analysisWorker = new Worker(new URL("./analysis.worker", import.meta.url));
  pendingCount() { return this.tracks().filter((track) => track.analysis_status === "pending").length; }
  failedCount() { return this.tracks().filter((track) => track.analysis_status === "failed").length; }
  filteredTracks() { const term = this.searchQuery().trim().toLowerCase(); return term ? this.tracks().filter((track) => track.filename.toLowerCase().includes(term)) : this.tracks(); }
  currentTrack() { return this.queue().find((track) => track.id === this.currentTrackId()) ?? null; }
  isQueued(id: number) { return this.queue().some((track) => track.id === id); }
  analysisLabel(track: TrackSummary) { return track.analysis_status === "analyzed" && track.bpm ? `${Math.round(track.bpm)} BPM` : track.analysis_status; }
  async ngOnInit() { await this.refresh(); void this.processPendingTracks(); this.unsubscribe = window.segue.onLibraryChanged(() => { void this.refresh().then(() => this.processPendingTracks()); }); }
  ngOnDestroy() { this.unsubscribe?.(); this.analysisWorker.terminate(); }
  setSearch(value: string) { this.searchQuery.set(value); }
  addToQueue(track: TrackSummary) { if (!this.isQueued(track.id)) { this.queue.update((queue) => [...queue, track]); this.status.set(`${track.filename} added to queue.`); } }
  removeFromQueue(id: number) { this.queue.update((queue) => queue.filter((track) => track.id !== id)); if (this.currentTrackId() === id) this.currentTrackId.set(null); }
  clearQueue() { this.queue.set([]); this.currentTrackId.set(null); this.status.set("Queue cleared."); }
  cueTrack(track: TrackSummary) { this.currentTrackId.set(track.id); this.status.set(`${track.filename} is cued for playback.`); }
  async retryFailed() { const count = await window.segue.retryFailedAnalysis(); this.status.set(`${count} failed ${count === 1 ? "track" : "tracks"} returned to analysis.`); await this.refresh(); void this.processPendingTracks(); }
  async chooseFolder() { this.busy.set(true); this.status.set("Scanning local music files…"); try { const result = await window.segue.chooseLibraryFolder(); if (result) this.status.set(`Found ${result.audioFilesFound} supported audio files.`); else this.status.set("Folder selection cancelled."); await this.refresh(); void this.processPendingTracks(); } catch { this.status.set("Unable to scan this folder."); } finally { this.busy.set(false); } }
  async refresh() { this.tracks.set(await window.segue.listTracks()); this.roots.set(await window.segue.listLibraryRoots()); }
  async processPendingTracks() {
    if (this.analysisInFlight) return;
    this.analysisInFlight = true;
    try {
      while (true) {
        const track = await window.segue.claimPendingAnalysis();
        if (!track) break;
        this.analysisTrackName.set(track.filename); await this.refresh();
        try {
          const bytes = await window.segue.readTrackForAnalysis(track.id);
          const context = new AudioContext({ sampleRate: 44100 });
          try {
            const decoded = await context.decodeAudioData(bytes);
            const mono = this.downmixToMono(decoded);
            const result = await this.analyzeMono(track.id, mono, decoded.duration);
            await window.segue.completeTrackAnalysis(track.id, result);
          } finally { await context.close(); }
        } catch (error) {
          console.error(`Analysis failed for ${track.filename}`, error);
          await window.segue.failTrackAnalysis(track.id);
        }
        await this.refresh();
      }
    } finally { this.analysisTrackName.set(null); this.analysisInFlight = false; }
  }
  downmixToMono(audio: AudioBuffer) {
    const mono = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel += 1) { const samples = audio.getChannelData(channel); for (let index = 0; index < audio.length; index += 1) mono[index] += samples[index] / audio.numberOfChannels; }
    return mono;
  }
  analyzeMono(id: number, mono: Float32Array, durationSeconds: number): Promise<AnalysisResult> {
    return new Promise((resolve, reject) => {
      this.analysisWorker.onmessage = ({ data }) => data.ok ? resolve(data.result as AnalysisResult) : reject(new Error(data.error || "Essentia analysis failed."));
      this.analysisWorker.onerror = (event) => reject(event.error || new Error(event.message));
      this.analysisWorker.postMessage({ id, monoBuffer: mono.buffer, durationSeconds }, [mono.buffer]);
    });
  }
}
bootstrapApplication(AppComponent).catch(console.error);
