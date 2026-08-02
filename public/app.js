const $ = (selector) => document.querySelector(selector);

const state = {
  tracks: [],
  filtered: [],
  selectedId: null,
  queue: [],
  queueIndex: -1,
  downloads: new Map(),
  shuffle: false,
  repeat: false,
  source: "",
  localRoot: "",
  directoryHandle: null,
  needsReconnect: false
};

const audio = $("#audio");
const trackList = $("#track-list");
const queueList = $("#queue-list");
const libraryArea = $(".library-area");
const libraryShell = $(".library-shell");
const libraryResizer = $("#library-resizer");
const audioExtensions = new Set(["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus"]);
const mobileViewport = window.matchMedia("(max-width: 600px)");
const libraryDatabase = "jdanwire-library";
const libraryStore = "settings";
const directoryHandleKey = "music-directory";
let currentObjectUrl = null;
let libraryResizeStart = null;

function libraryPaneLimits() {
  const styles = getComputedStyle(libraryArea);
  const minimum = parseFloat(styles.getPropertyValue("--library-pane-min-height")) || 156;
  const queueMinimum = parseFloat(styles.getPropertyValue("--queue-pane-min-height")) || 82;
  const fixedHeight = [
    $(".library-tab"),
    libraryResizer,
    $(".action-strip"),
    $(".queue-heading"),
    $(".queue-actions")
  ].reduce((total, element) => total + element.getBoundingClientRect().height, 0);
  return { minimum, maximum: Math.max(minimum, libraryArea.clientHeight - fixedHeight - queueMinimum) };
}

function updateLibraryResizerAria() {
  const { minimum, maximum } = libraryPaneLimits();
  libraryResizer.setAttribute("aria-valuemin", Math.round(minimum));
  libraryResizer.setAttribute("aria-valuemax", Math.round(maximum));
  libraryResizer.setAttribute("aria-valuenow", Math.round(libraryShell.getBoundingClientRect().height));
}

function setLibraryPaneHeight(height) {
  const { minimum, maximum } = libraryPaneLimits();
  const nextHeight = Math.min(maximum, Math.max(minimum, Math.round(height)));
  libraryArea.style.setProperty("--library-pane-height", `${nextHeight}px`);
  updateLibraryResizerAria();
}

libraryResizer.addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  libraryResizeStart = { y: event.clientY, height: libraryShell.getBoundingClientRect().height };
  libraryResizer.setPointerCapture?.(event.pointerId);
  document.body.classList.add("resizing-library-pane");
  event.preventDefault();
});
libraryResizer.addEventListener("pointermove", event => {
  if (!libraryResizeStart) return;
  setLibraryPaneHeight(libraryResizeStart.height + event.clientY - libraryResizeStart.y);
});
function finishLibraryResize(event) {
  if (!libraryResizeStart) return;
  libraryResizeStart = null;
  if (libraryResizer.hasPointerCapture?.(event.pointerId)) libraryResizer.releasePointerCapture(event.pointerId);
  document.body.classList.remove("resizing-library-pane");
}
libraryResizer.addEventListener("pointerup", finishLibraryResize);
libraryResizer.addEventListener("pointercancel", finishLibraryResize);
libraryResizer.addEventListener("keydown", event => {
  const currentHeight = libraryShell.getBoundingClientRect().height;
  if (event.key === "ArrowUp") setLibraryPaneHeight(currentHeight - 20);
  else if (event.key === "ArrowDown") setLibraryPaneHeight(currentHeight + 20);
  else if (event.key === "Home") setLibraryPaneHeight(libraryPaneLimits().minimum);
  else if (event.key === "End") setLibraryPaneHeight(libraryPaneLimits().maximum);
  else return;
  event.preventDefault();
});
window.addEventListener("resize", () => {
  if (libraryArea.style.getPropertyValue("--library-pane-height")) {
    setLibraryPaneHeight(libraryShell.getBoundingClientRect().height);
  } else {
    updateLibraryResizerAria();
  }
});
requestAnimationFrame(updateLibraryResizerAria);

function syncFilterSelectSizes() {
  ["#genre-filter", "#artist-filter", "#album-filter"].forEach(selector => {
    const select = $(selector);
    select.size = mobileViewport.matches ? 1 : Number(select.dataset.desktopSize);
  });
}

mobileViewport.addEventListener?.("change", syncFilterSelectSizes);
if (!mobileViewport.addEventListener) mobileViewport.addListener(syncFilterSelectSizes);
syncFilterSelectSizes();

function formatBytes(bytes) {
  if (!bytes) return "—";
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  return `${mins}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function esc(text) {
  return String(text ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function fileExtension(name) {
  return name.split(".").pop().toLowerCase();
}

function isAudioFile(file) {
  return audioExtensions.has(fileExtension(file.name));
}

function openLibraryDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(libraryDatabase, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(libraryStore), { once: true });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

async function readStoredDirectoryHandle() {
  const database = await openLibraryDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(libraryStore, "readonly");
    const request = transaction.objectStore(libraryStore).get(directoryHandleKey);
    request.addEventListener("success", () => resolve(request.result || null), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    transaction.addEventListener("complete", () => database.close(), { once: true });
  });
}

async function storeDirectoryHandle(handle) {
  const database = await openLibraryDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(libraryStore, "readwrite");
    transaction.objectStore(libraryStore).put(handle, directoryHandleKey);
    transaction.addEventListener("complete", () => { database.close(); resolve(); }, { once: true });
    transaction.addEventListener("error", () => { database.close(); reject(transaction.error); }, { once: true });
  });
}

async function directoryPermissionGranted(handle) {
  if (typeof handle.queryPermission !== "function") return true;
  return await handle.queryPermission({ mode: "read" }) === "granted";
}

async function collectDirectoryFiles(handle) {
  const files = [];
  async function visit(directory, relativeDirectory) {
    for await (const entry of directory.values()) {
      const relative = `${relativeDirectory}/${entry.name}`;
      if (entry.kind === "directory") await visit(entry, relative);
      else {
        const file = await entry.getFile();
        if (isAudioFile(file)) files.push({ file, relative });
      }
    }
  }
  await visit(handle, handle.name);
  return files;
}

async function mapLimited(items, limit, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

function readLocalDuration(file) {
  return new Promise(resolve => {
    const probe = new Audio();
    const url = URL.createObjectURL(file);
    let finished = false;
    const finish = duration => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(url);
      probe.removeAttribute("src");
      resolve(Number.isFinite(duration) ? duration : 0);
    };
    const timeout = setTimeout(() => finish(0), 8000);
    probe.preload = "metadata";
    probe.addEventListener("loadedmetadata", () => { clearTimeout(timeout); finish(probe.duration); }, { once: true });
    probe.addEventListener("error", () => { clearTimeout(timeout); finish(0); }, { once: true });
    probe.src = url;
  });
}

async function indexLocalFile(fileEntry, index) {
  const file = fileEntry.file || fileEntry;
  const relative = fileEntry.relative || file.webkitRelativePath || file.name;
  const parts = relative.split("/");
  const extension = fileExtension(file.name);
  const filename = file.name.slice(0, -(extension.length + 1));
  const trackMatch = filename.match(/^(\d+)\s*[-_.]\s*/);
  const withoutTrack = filename.replace(/^\d+\s*[-_.]\s*/, "");
  const nameParts = withoutTrack.split(" - ");
  const duration = await readLocalDuration(file);
  return {
    id: `local-${file.lastModified}-${file.size}-${index}`,
    relative,
    title: nameParts.length > 1 ? nameParts.slice(1).join(" - ") : withoutTrack,
    artist: nameParts.length > 1 ? nameParts[0] : "Unknown Artist",
    album: parts.length > 1 ? parts[parts.length - 2] : "Loose Tracks",
    genre: "Unknown",
    track: Number(trackMatch?.[1] || index + 1),
    size: file.size,
    duration,
    bitrate: duration ? Math.round(file.size * 8 / duration) : 0,
    sampleRate: 0,
    codec: extension.toUpperCase(),
    file
  };
}

function releaseCurrentObjectUrl() {
  if (!currentObjectUrl) return;
  URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = null;
}

function uniqueValues(key) {
  return [...new Set(state.tracks.map(track => track[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function fillSelect(selector, key) {
  const select = $(selector);
  const values = uniqueValues(key);
  select.innerHTML = `<option value="">All (${state.tracks.length})</option>` + values.map(value => {
    const count = state.tracks.filter(track => track[key] === value).length;
    return `<option value="${esc(value)}">${esc(value)} (${count})</option>`;
  }).join("");
  select.value = "";
}

function renderTracks() {
  $("#tab-title").textContent = `My Music Collection (${state.filtered.length})`;
  if (!state.filtered.length) {
    trackList.innerHTML = `<tr><td colspan="8" class="loading-cell">No matching music files found.</td></tr>`;
    return;
  }
  trackList.innerHTML = state.filtered.map(track => `
    <tr data-id="${track.id}" class="${track.id === state.selectedId ? "selected" : ""}">
      <td><span class="stars">★★★★★</span></td>
      <td>${track.track || "—"}</td>
      <td class="song-title" title="${esc(track.title)}">${esc(track.title)}</td>
      <td title="${esc(track.artist)}">${esc(track.artist)}</td>
      <td title="${esc(track.album)}">${esc(track.album)}</td>
      <td>${formatBytes(track.size)}</td>
      <td>${esc(track.codec)}</td>
      <td>${track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : "Lossless"}</td>
    </tr>`).join("");
}

function applyFilters() {
  const query = $("#search-input").value.trim().toLowerCase();
  const genre = $("#genre-filter").value;
  const artist = $("#artist-filter").value;
  const album = $("#album-filter").value;
  state.filtered = state.tracks.filter(track =>
    (!genre || track.genre === genre) &&
    (!artist || track.artist === artist) &&
    (!album || track.album === album) &&
    (!query || [track.title, track.artist, track.album, track.genre].some(value => value.toLowerCase().includes(query)))
  );
  renderTracks();
}

function selectedTrack() {
  return state.tracks.find(track => track.id === state.selectedId);
}

function selectTrack(id) {
  state.selectedId = id;
  $("#queue-button").disabled = false;
  $("#play-selection").disabled = false;
  trackList.querySelectorAll("tr[data-id]").forEach(row => row.classList.toggle("selected", row.dataset.id === id));
}

function addToQueue(track, playNow = false) {
  if (!track) return;
  let index = state.queue.findIndex(item => item.id === track.id);
  if (index < 0) {
    state.queue.push(track);
    index = state.queue.length - 1;
    startFakeDownload(track, playNow);
  } else {
    const download = state.downloads.get(track.id);
    if (download && !download.done) download.playWhenReady ||= playNow;
    else if (playNow) playQueueIndex(index);
  }
  renderQueue();
}

function startFakeDownload(track, playWhenReady) {
  const anotherSongIsPlaying = state.queueIndex >= 0 && !audio.paused;
  const minSeconds = anotherSongIsPlaying ? 3 : 1;
  const maxSeconds = anotherSongIsPlaying ? 20 : 5;
  const duration = (minSeconds + Math.random() * (maxSeconds - minSeconds)) * 1000;
  const startedAt = Date.now();
  const download = { progress: 0, done: false, playWhenReady, timer: null };
  state.downloads.set(track.id, download);
  download.timer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    download.progress = Math.min(100, Math.round(elapsed / duration * 100));
    if (download.progress >= 100) {
      clearInterval(download.timer);
      download.done = true;
      renderQueue();
      if (download.playWhenReady) {
        const index = state.queue.findIndex(item => item.id === track.id);
        if (index >= 0) playQueueIndex(index);
      }
      return;
    }
    renderQueue();
  }, 100);
}

function renderQueue() {
  $("#queue-summary").textContent = `${state.queue.length} track${state.queue.length === 1 ? "" : "s"}`;
  $("#remove-queue").disabled = state.queue.length === 0;
  if (!state.queue.length) {
    queueList.innerHTML = `<tr class="empty-queue"><td colspan="5">Double-click a song to begin playback.</td></tr>`;
    return;
  }
  queueList.innerHTML = state.queue.map((track, index) => {
    const download = state.downloads.get(track.id);
    const status = download && !download.done
      ? `<div class="download-status"><div class="progress-indicator" role="progressbar" aria-label="Downloading ${esc(track.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${download.progress}"><span class="progress-indicator-bar" style="width:${download.progress}%"></span></div><span class="download-percent">${download.progress}%</span></div>`
      : index === state.queueIndex ? (audio.paused ? "Paused" : "Playing") : "Queued";
    return `
    <tr data-queue-index="${index}" class="${index === state.queueIndex ? "active" : ""}">
      <td>${index + 1}</td><td>${esc(track.title)}</td><td>${esc(track.artist)}</td>
      <td>${status}</td><td>${formatTime(track.duration)}</td>
    </tr>`;
  }).join("");
}

function resetPlayer() {
  audio.pause();
  releaseCurrentObjectUrl();
  audio.removeAttribute("src");
  audio.removeAttribute("data-track-id");
  audio.load();
  state.downloads.forEach(download => clearInterval(download.timer));
  state.downloads.clear();
  state.queue = [];
  state.queueIndex = -1;
  $("#now-title").textContent = "Nothing playing";
  $("#now-artist").textContent = "Choose a track from your local library";
  renderQueue();
  updatePlayState();
}

async function playQueueIndex(index) {
  if (!state.queue.length) return;
  state.queueIndex = (index + state.queue.length) % state.queue.length;
  const track = state.queue[state.queueIndex];
  const download = state.downloads.get(track.id);
  if (download && !download.done) {
    download.playWhenReady = true;
    renderQueue();
    return;
  }
  if (audio.dataset.trackId !== track.id) {
    releaseCurrentObjectUrl();
    if (track.file) {
      currentObjectUrl = URL.createObjectURL(track.file);
      audio.src = currentObjectUrl;
    } else {
      audio.src = `/media/${track.id}`;
    }
    audio.dataset.trackId = track.id;
  }
  $("#now-title").textContent = track.title;
  $("#now-artist").textContent = `${track.artist} — ${track.album}`;
  document.title = "jdanwire";
  try { await audio.play(); } catch (error) { console.warn("Playback needs a user gesture", error); }
  updatePlayState();
  renderQueue();
}

function nextTrack(direction = 1) {
  if (!state.queue.length) return;
  if (state.shuffle && state.queue.length > 1) {
    let next;
    do { next = Math.floor(Math.random() * state.queue.length); } while (next === state.queueIndex);
    playQueueIndex(next);
  } else {
    playQueueIndex(state.queueIndex < 0 ? 0 : state.queueIndex + direction);
  }
}

function updatePlayState() {
  const playing = !audio.paused && !audio.ended;
  $("#play-pause .transport-image").src = `/assets/kde-crystal/transport/${playing ? "pause" : "play"}.png`;
  $("#play-pause").title = playing ? "Pause" : "Play";
  $("#play-pause").setAttribute("aria-label", playing ? "Pause" : "Play");
  $("#pause-large .queue-action-icon").src = `/assets/kde-crystal/actions/${playing ? "pause" : "play"}.png`;
  $("#pause-large").lastChild.textContent = playing ? "Pause" : "Resume";
  renderQueue();
}

trackList.addEventListener("click", event => {
  if (event.target.closest(".folder-prompt")) {
    chooseMusicFolder();
    return;
  }
  const row = event.target.closest("tr[data-id]");
  if (row) {
    selectTrack(row.dataset.id);
    if (event.detail === 2) addToQueue(selectedTrack(), true);
  }
});
trackList.addEventListener("keydown", event => {
  if (event.target.closest(".folder-prompt") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    chooseMusicFolder();
  }
});
queueList.addEventListener("dblclick", event => {
  const row = event.target.closest("tr[data-queue-index]");
  if (row) playQueueIndex(Number(row.dataset.queueIndex));
});

$("#queue-button").addEventListener("click", () => addToQueue(selectedTrack()));
$("#play-selection").addEventListener("click", () => addToQueue(selectedTrack(), true));
$("#queue-all").addEventListener("click", () => {
  const ids = new Set(state.queue.map(track => track.id));
  state.queue.push(...state.filtered.filter(track => !ids.has(track.id)));
  renderQueue();
});
$("#remove-queue").addEventListener("click", () => {
  resetPlayer();
});
$("#play-pause").addEventListener("click", () => {
  if (!audio.src && state.queue.length) playQueueIndex(state.queueIndex < 0 ? 0 : state.queueIndex);
  else if (audio.paused) audio.play(); else audio.pause();
});
$("#pause-large").addEventListener("click", () => $("#play-pause").click());
$("#previous").addEventListener("click", () => nextTrack(-1));
$("#next").addEventListener("click", () => nextTrack(1));
$("#stop").addEventListener("click", () => { audio.pause(); audio.currentTime = 0; });
$("#shuffle-button").addEventListener("click", event => {
  state.shuffle = !state.shuffle;
  event.currentTarget.classList.toggle("on", state.shuffle);
  event.currentTarget.querySelector("img").src = `/assets/kde-crystal/actions/shuffle-${state.shuffle ? "on" : "off"}.png`;
});
$("#repeat-button").addEventListener("click", event => {
  state.repeat = !state.repeat;
  event.currentTarget.classList.toggle("on", state.repeat);
  event.currentTarget.querySelector("img").src = `/assets/kde-crystal/actions/repeat-${state.repeat ? "on" : "off"}.png`;
  event.currentTarget.lastChild.textContent = state.repeat ? "Repeat On" : "Repeat Off";
});
$("#volume").addEventListener("input", event => audio.volume = Number(event.target.value));
$("#seek").addEventListener("input", event => {
  if (Number.isFinite(audio.duration)) audio.currentTime = Number(event.target.value) / 1000 * audio.duration;
});
$("#search-input").addEventListener("input", applyFilters);
["#genre-filter", "#artist-filter", "#album-filter"].forEach(selector => $(selector).addEventListener("change", applyFilters));
$("#clear-filters").addEventListener("click", () => {
  $("#search-input").value = "";
  ["#genre-filter", "#artist-filter", "#album-filter"].forEach(selector => $(selector).value = "");
  applyFilters();
});
$(".toolbar-tab[data-panel='search']").addEventListener("click", () => {
  $(".search-wrap").classList.toggle("visible");
  $("#search-input").focus();
});
$("#choose-folder").addEventListener("click", chooseMusicFolder);
$("#folder-picker").addEventListener("change", event => loadLocalFiles(event.target.files));

audio.addEventListener("play", updatePlayState);
audio.addEventListener("pause", updatePlayState);
audio.addEventListener("loadedmetadata", () => $("#time-total").textContent = formatTime(audio.duration));
audio.addEventListener("timeupdate", () => {
  $("#time-current").textContent = formatTime(audio.currentTime);
  $("#seek").value = Number.isFinite(audio.duration) && audio.duration ? Math.round(audio.currentTime / audio.duration * 1000) : 0;
});
audio.addEventListener("ended", () => state.repeat ? playQueueIndex(state.queueIndex) : nextTrack(1));
audio.addEventListener("error", () => {
  $("#now-artist").textContent = "This browser could not decode the audio file.";
  updatePlayState();
});

function setFolderButtonLabel(label) {
  $("#folder-button-label").textContent = label;
}

async function loadLocalFiles(fileList, rootName = "") {
  const files = [...fileList]
    .map(item => item.file ? item : { file: item, relative: item.webkitRelativePath || item.name })
    .filter(item => isAudioFile(item.file));
  if (!files.length) {
    showFolderPrompt();
    trackList.innerHTML = `<tr><td colspan="8" class="loading-cell folder-prompt" role="button" tabindex="0">That folder contains no supported audio files. Choose another folder.</td></tr>`;
    return;
  }
  resetPlayer();
  state.selectedId = null;
  $("#queue-button").disabled = true;
  $("#play-selection").disabled = true;
  $("#choose-folder").disabled = true;
  setFolderButtonLabel("Indexing Music…");
  trackList.innerHTML = `<tr><td colspan="8" class="loading-cell">Reading ${files.length} local music files…</td></tr>`;
  state.tracks = await mapLimited(files, 4, indexLocalFile);
  state.filtered = [...state.tracks].sort((a, b) => a.relative.localeCompare(b.relative));
  state.source = "browser";
  state.localRoot = rootName || files[0].relative.split("/")[0] || "Selected files";
  state.needsReconnect = false;
  fillSelect("#genre-filter", "genre");
  fillSelect("#artist-filter", "artist");
  fillSelect("#album-filter", "album");
  renderTracks();
  $("#queue-all").disabled = false;
  $("#connection-copy").textContent = `${state.tracks.length} local tracks • ${state.localRoot} • browser only`;
  $("#track-count").textContent = state.tracks.length;
  $("#choose-folder").disabled = false;
  setFolderButtonLabel("Change Music Folder");
}

async function loadDirectoryHandle(handle) {
  $("#choose-folder").disabled = true;
  setFolderButtonLabel("Reading Music Folder…");
  $("#connection-copy").textContent = `Reading ${handle.name}…`;
  trackList.innerHTML = `<tr><td colspan="8" class="loading-cell">Reading your music folder…</td></tr>`;
  const files = await collectDirectoryFiles(handle);
  await loadLocalFiles(files, handle.name);
}

function chooseMusicFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    const picker = $("#folder-picker");
    picker.value = "";
    picker.click();
    return;
  }
  choosePersistentMusicFolder();
}

function choosePersistentMusicFolder() {
  if (state.directoryHandle && state.needsReconnect) {
    reconnectDirectoryHandle(state.directoryHandle);
    return;
  }
  pickNewDirectoryHandle();
}

async function reconnectDirectoryHandle(handle) {
  let permissionPromise;
  try {
    // Request permission before yielding so the call keeps the click's user activation.
    permissionPromise = typeof handle.requestPermission === "function"
      ? handle.requestPermission({ mode: "read" })
      : Promise.resolve("granted");
  } catch (error) {
    showFolderRetry("Could not request folder permission. Click to choose the folder again.");
    console.warn("Could not request music folder permission", error);
    return;
  }

  $("#choose-folder").disabled = true;
  setFolderButtonLabel("Reconnecting…");
  $("#connection-copy").textContent = `Requesting access to ${handle.name}…`;
  trackList.innerHTML = `<tr><td colspan="8" class="loading-cell">Waiting for folder permission…</td></tr>`;

  try {
    const permission = await permissionPromise;
    if (permission !== "granted") {
      showFolderRetry("Folder permission was not granted. Click to choose the folder again.");
      return;
    }
    await loadDirectoryHandle(handle);
  } catch (error) {
    showFolderRetry("Could not reconnect that folder. Click to choose it again.");
    console.warn("Could not reconnect the music folder", error);
  }
}

async function pickNewDirectoryHandle() {
  try {
    const handle = await window.showDirectoryPicker({ id: "jdanwire-music", mode: "read" });
    state.directoryHandle = handle;
    try { await storeDirectoryHandle(handle); }
    catch (error) { console.warn("Could not remember the music folder", error); }
    await loadDirectoryHandle(handle);
  } catch (error) {
    if (error.name !== "AbortError") {
      console.warn("Could not open the music folder", error);
      showFolderRetry("Could not open that folder. Click to try again.");
    }
  }
}

function showFolderRetry(message) {
  state.needsReconnect = false;
  $("#choose-folder").disabled = false;
  setFolderButtonLabel("Choose Folder Again");
  $("#connection-copy").textContent = message;
  trackList.innerHTML = `<tr><td colspan="8" class="loading-cell folder-prompt" role="button" tabindex="0">${message}</td></tr>`;
}

function showFolderPrompt(reconnect = false) {
  resetPlayer();
  state.tracks = [];
  state.filtered = [];
  state.selectedId = null;
  state.source = "browser";
  state.localRoot = "";
  state.needsReconnect = reconnect;
  fillSelect("#genre-filter", "genre");
  fillSelect("#artist-filter", "artist");
  fillSelect("#album-filter", "album");
  $("#queue-button").disabled = true;
  $("#play-selection").disabled = true;
  $("#queue-all").disabled = true;
  $("#choose-folder").disabled = false;
  $("#tab-title").textContent = "My Music Collection (0)";
  trackList.innerHTML = `<tr><td colspan="8" class="loading-cell folder-prompt" role="button" tabindex="0">${reconnect ? "Reconnect your remembered music folder to restore the library." : "Choose a music folder to build your private local library."}</td></tr>`;
  $("#connection-copy").textContent = reconnect ? "Music folder remembered • permission required" : "No folder selected • files stay on this device";
  $("#track-count").textContent = "0";
  setFolderButtonLabel(reconnect ? "Reconnect Music Folder" : "Choose Music Folder");
}

async function restoreDirectoryHandle() {
  if (typeof window.showDirectoryPicker !== "function" || !window.indexedDB) return false;
  try {
    const handle = await readStoredDirectoryHandle();
    if (!handle) return false;
    state.directoryHandle = handle;
    if (await directoryPermissionGranted(handle)) await loadDirectoryHandle(handle);
    else showFolderPrompt(true);
    return true;
  } catch (error) {
    console.warn("Could not restore the remembered music folder", error);
    return false;
  }
}

async function loadLibrary() {
  const isLocalServer = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (!isLocalServer) {
    showFolderPrompt();
    return;
  }
  try {
    const response = await fetch("/api/library");
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const data = await response.json();
    state.tracks = data.tracks;
    state.filtered = [...data.tracks];
    state.source = data.source;
    fillSelect("#genre-filter", "genre");
    fillSelect("#artist-filter", "artist");
    fillSelect("#album-filter", "album");
    renderTracks();
    $("#queue-all").disabled = state.tracks.length === 0;
    const folder = data.source.replace(/^\/Users\/[^/]+/, "~");
    $("#connection-copy").textContent = `${state.tracks.length} local tracks • ${folder}`;
    $("#track-count").textContent = state.tracks.length;
  } catch {
    showFolderPrompt();
  }
}

function updateLocalClock() {
  $("#local-time").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function initializeLibrary() {
  if (await restoreDirectoryHandle()) return;
  await loadLibrary();
}

audio.volume = 0.8;
initializeLibrary();
updateLocalClock();
setInterval(updateLocalClock, 30_000);
window.addEventListener("beforeunload", releaseCurrentObjectUrl);
