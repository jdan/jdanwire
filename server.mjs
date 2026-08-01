import http from "node:http";
import { createReadStream, existsSync, promises as fs, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(process.cwd(), "public");
const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus"]);

const musicDirArgument = process.argv[2];
if (!musicDirArgument) {
  console.error("Usage: npm start -- /path/to/music");
  process.exit(1);
}

const MUSIC_DIR = path.resolve(musicDirArgument.replace(/^~(?=\/|$)/, os.homedir()));
try {
  if (!statSync(MUSIC_DIR).isDirectory()) throw new Error("not a directory");
} catch {
  console.error(`Music directory does not exist or is not a directory: ${MUSIC_DIR}`);
  process.exit(1);
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg"
};

function safeJoin(root, relative) {
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function walk(dir, root = dir) {
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await walk(full, root));
    else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(path.relative(root, full));
  }
  return output;
}

function ffprobe(file) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file]);
    let text = "";
    child.stdout.on("data", chunk => text += chunk);
    child.on("error", () => resolve(null));
    child.on("close", code => {
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(text)); } catch { resolve(null); }
    });
  });
}

function inferFromFilename(relative) {
  const ext = path.extname(relative);
  const raw = path.basename(relative, ext).replace(/^\d+\s*[-_.]\s*/, "");
  const pieces = raw.split(" - ");
  const folder = path.basename(path.dirname(relative));
  return {
    title: pieces.length > 1 ? pieces.slice(1).join(" - ") : raw,
    artist: pieces.length > 1 ? pieces[0] : "Unknown Artist",
    album: folder === "." ? "Loose Tracks" : folder
  };
}

async function metadataFor(relative, index) {
  const full = safeJoin(MUSIC_DIR, relative);
  const [info, stat] = await Promise.all([ffprobe(full), fs.stat(full)]);
  const guessed = inferFromFilename(relative);
  const tags = info?.format?.tags || {};
  const stream = info?.streams?.find(item => item.codec_type === "audio") || {};
  const trackText = String(tags.track || tags.TRACK || "").split("/")[0];
  const filenameTrack = path.basename(relative).match(/^(\d+)/)?.[1];
  return {
    id: Buffer.from(relative).toString("base64url"),
    relative,
    title: tags.title || tags.TITLE || guessed.title,
    artist: tags.artist || tags.ARTIST || guessed.artist,
    album: tags.album || tags.ALBUM || guessed.album,
    genre: tags.genre || tags.GENRE || "House",
    track: Number(trackText || filenameTrack || index + 1),
    size: stat.size,
    duration: Number(info?.format?.duration || stream.duration || 0),
    bitrate: Number(info?.format?.bit_rate || stream.bit_rate || 0),
    sampleRate: Number(stream.sample_rate || 0),
    codec: (stream.codec_name || path.extname(relative).slice(1)).toUpperCase()
  };
}

async function mapLimited(items, limit, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      result[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

let libraryPromise;
async function getLibrary() {
  libraryPromise ||= walk(MUSIC_DIR).then(files => mapLimited(files.sort(), 6, metadataFor));
  return libraryPromise;
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function serveFile(req, res, file, contentType) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("Not a file");
    const range = req.headers.range;
    if (range) {
      const [startText, endText] = range.replace("bytes=", "").split("-");
      const start = Number(startText || 0);
      const end = Math.min(Number(endText || stat.size - 1), stat.size - 1);
      if (start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache"
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": contentType.startsWith("audio/") ? "no-cache" : "public, max-age=300"
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/library") {
    const tracks = await getLibrary();
    return json(res, 200, { tracks, source: MUSIC_DIR });
  }
  if (url.pathname.startsWith("/media/")) {
    try {
      const relative = Buffer.from(url.pathname.slice(7), "base64url").toString();
      const file = safeJoin(MUSIC_DIR, relative);
      if (!file) return json(res, 403, { error: "Invalid path" });
      return serveFile(req, res, file, mimeTypes[path.extname(file).toLowerCase()] || "application/octet-stream");
    } catch {
      return json(res, 400, { error: "Invalid media id" });
    }
  }
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = safeJoin(PUBLIC_DIR, requested);
  if (!file) return json(res, 403, { error: "Invalid path" });
  return serveFile(req, res, file, mimeTypes[path.extname(file).toLowerCase()] || "application/octet-stream");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`jdanwire is running at http://localhost:${PORT}`);
  console.log(`Music library: ${MUSIC_DIR}`);
  getLibrary().then(tracks => console.log(`Indexed ${tracks.length} tracks.`));
});
