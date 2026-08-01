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
  source: ""
};

const audio = $("#audio");
const trackList = $("#track-list");
const queueList = $("#queue-list");

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
    audio.src = `/media/${track.id}`;
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
  const row = event.target.closest("tr[data-id]");
  if (row) {
    selectTrack(row.dataset.id);
    if (event.detail === 2) addToQueue(selectedTrack(), true);
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
  audio.pause(); audio.removeAttribute("src"); audio.load();
  state.downloads.forEach(download => clearInterval(download.timer));
  state.downloads.clear();
  state.queue = []; state.queueIndex = -1;
  $("#now-title").textContent = "Nothing playing";
  $("#now-artist").textContent = "Choose a track from your local library";
  renderQueue(); updatePlayState();
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

async function loadLibrary() {
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
  } catch (error) {
    trackList.innerHTML = `<tr><td colspan="8" class="loading-cell">Could not load the local library: ${esc(error.message)}</td></tr>`;
    $("#connection-copy").textContent = "Local library unavailable";
  }
}

const weatherCodes = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy",
  45: "Fog", 48: "Icy fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle",
  56: "Icy drizzle", 57: "Icy drizzle", 61: "Rain", 63: "Rain", 65: "Heavy rain",
  66: "Icy rain", 67: "Icy rain", 71: "Snow", 73: "Snow", 75: "Heavy snow",
  77: "Snow grains", 80: "Showers", 81: "Showers", 82: "Heavy showers",
  85: "Snow showers", 86: "Snow showers", 95: "Thunderstorms", 96: "Thunderstorms", 99: "Thunderstorms"
};

function updateLocalClock() {
  $("#local-time").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function updateLocalWeather() {
  try {
    const response = await fetch("/api/weather");
    if (!response.ok) throw new Error("Weather unavailable");
    const weather = await response.json();
    $("#local-weather").textContent = `${Math.round(weather.temperature)}°F ${weatherCodes[weather.code] || "Weather"}`;
    $("#local-info").title = `Local conditions near ${weather.location}`;
  } catch {
    $("#local-weather").textContent = "Weather offline";
  }
}

audio.volume = 0.8;
loadLibrary();
updateLocalClock();
updateLocalWeather();
setInterval(updateLocalClock, 30_000);
setInterval(updateLocalWeather, 10 * 60_000);
