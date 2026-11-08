require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const archiver = require("archiver");

const app = express();
app.use(express.json({ limit: "10kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.YOUTUBE_API_KEY;

// ---- MP3 export settings (all optional, see .env.example) ----
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "";            // path to ffmpeg binary or its folder; empty = use PATH
const COOKIES_FILE = process.env.COOKIES_FILE || "";     // optional cookies.txt for yt-dlp
const MAX_TRACKS = parseInt(process.env.MAX_AUDIO_TRACKS, 10) || 100;
const CONCURRENCY = Math.min(parseInt(process.env.AUDIO_CONCURRENCY, 10) || 2, 6);
const MAX_ACTIVE_JOBS = 3;
const JOB_TTL_MS = 30 * 60 * 1000;
const BITRATES = [128, 192, 256, 320];

// Serve only the public front-end files (never the whole folder, so .env stays private)
const PUBLIC_FILES = ["index.html", "style.css", "script.js", "logo.png", "logo-mark.png", "favicon.png", "apple-touch-icon.png"];
PUBLIC_FILES.forEach(f => {
  app.get(f === "index.html" ? ["/", "/index.html"] : "/" + f, (req, res) =>
    res.sendFile(path.join(__dirname, f)));
});

function getPlaylistId(text){
  text = (text || "").trim();
  try { const id = new URL(text).searchParams.get("list"); if (id) return id; } catch(e){}
  return /^(PL|UU|LL|FL|OL)[\w-]{10,}$/.test(text) ? text : null;
}

async function yt(endpoint, params){
  const q = new URLSearchParams({ ...params, key: API_KEY }).toString();
  const r = await fetch("https://www.googleapis.com/youtube/v3/" + endpoint + "?" + q);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error && j.error.message ? j.error.message : "YouTube API error (" + r.status + ")");
  return j;
}

// Shared by the title list and the MP3 export. Errors carry an HTTP status.
async function fetchPlaylist(rawUrl){
  if (!API_KEY) throw Object.assign(new Error("Server is missing YOUTUBE_API_KEY. Add it to your .env file and restart."), { status: 500 });

  const id = getPlaylistId(rawUrl);
  if (!id) throw Object.assign(new Error("That doesn't look like a playlist link. It should contain ?list=..."), { status: 400 });

  let info;
  try { info = await yt("playlists", { part: "snippet", id }); }
  catch (e) { throw Object.assign(e, { status: 502 }); }
  if (!info.items || !info.items.length) throw Object.assign(new Error("Playlist not found. Is it public or unlisted?"), { status: 404 });
  const title = info.items[0].snippet.title;

  const videos = [];
  let token = "";
  try {
    do {
      const p = { part: "snippet", playlistId: id, maxResults: 50 };
      if (token) p.pageToken = token;
      const j = await yt("playlistItems", p);
      j.items.forEach(it => {
        const t = it.snippet.title;
        if (t === "Private video" || t === "Deleted video") return;
        videos.push({ title: t, id: it.snippet.resourceId.videoId });
      });
      token = j.nextPageToken || "";
    } while (token);
  } catch (e) { throw Object.assign(e, { status: 502 }); }

  return { title, videos };
}

app.get("/api/playlist", async (req, res) => {
  try {
    res.json(await fetchPlaylist(req.query.url));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

/* =====================================================================
   MP3 export: yt-dlp grabs the best audio stream, ffmpeg (LAME) encodes
   it to MP3, archiver packs everything into a ZIP.
   ===================================================================== */

function probe(bin, args){
  return new Promise(resolve => {
    let p;
    try { p = spawn(bin, args, { stdio: "ignore" }); } catch(e){ return resolve(false); }
    p.on("error", () => resolve(false));
    p.on("close", code => resolve(code === 0));
  });
}

let toolsCache = null;
async function checkTools(){
  if (toolsCache && Date.now() - toolsCache.at < 30000) return toolsCache.val;
  let ffBin = FFMPEG || "ffmpeg";
  try { if (FFMPEG && fs.statSync(FFMPEG).isDirectory()) ffBin = path.join(FFMPEG, "ffmpeg"); } catch(e){}
  const [ytdlp, ffmpeg] = await Promise.all([probe(YTDLP, ["--version"]), probe(ffBin, ["-version"])]);
  const val = { ytdlp, ffmpeg, audio: ytdlp && ffmpeg };
  toolsCache = { at: Date.now(), val };
  return val;
}

app.get("/api/capabilities", async (req, res) => {
  const t = await checkTools();
  res.json({ ...t, bitrates: BITRATES, maxTracks: MAX_TRACKS });
});

const jobs = new Map();

const safeName = s => String(s).replace(/[\\/:*?"<>|\x00-\x1f]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "track";

function removeDir(dir){ fs.rm(dir, { recursive: true, force: true }, () => {}); }

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "running" && now - job.updatedAt > JOB_TTL_MS) {
      removeDir(job.dir);
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

function downloadTrack(job, video, n){
  return new Promise(resolve => {
    const base = path.join(job.dir, String(n).padStart(4, "0"));
    const args = [
      "-f", "bestaudio/best",
      "-x", "--audio-format", "mp3", "--audio-quality", job.bitrate + "K",
      "--no-playlist", "--no-warnings", "--no-progress", "--retries", "3",
      "--embed-metadata",
      "-o", base + ".%(ext)s"
    ];
    if (FFMPEG) args.push("--ffmpeg-location", FFMPEG);
    if (COOKIES_FILE) args.push("--cookies", COOKIES_FILE);
    args.push("--", "https://www.youtube.com/watch?v=" + video.id);

    let err = "";
    const p = spawn(YTDLP, args, { stdio: ["ignore", "ignore", "pipe"] });
    job.procs.add(p);
    p.stderr.on("data", d => { err = (err + d).slice(-600); });
    p.on("error", e => { job.procs.delete(p); resolve({ ok: false, reason: e.message }); });
    p.on("close", code => {
      job.procs.delete(p);
      const file = base + ".mp3";
      if (code === 0 && fs.existsSync(file)) return resolve({ ok: true, file });
      const line = err.trim().split("\n").filter(Boolean).pop() || ("yt-dlp exited with code " + code);
      resolve({ ok: false, reason: line.replace(/^ERROR:\s*/, "").slice(0, 200) });
    });
  });
}

async function runJob(job, videos){
  let next = 0;
  const used = new Set();
  const width = String(videos.length).length;

  const worker = async () => {
    while (!job.cancelled) {
      const i = next++;
      if (i >= videos.length) return;
      const v = videos[i];
      job.current.add(v.title);
      const r = await downloadTrack(job, v, i + 1);
      job.current.delete(v.title);
      if (job.cancelled) return;
      if (r.ok) {
        let name = job.numbered
          ? String(i + 1).padStart(width, "0") + " - " + safeName(v.title)
          : safeName(v.title);
        let unique = name, k = 2;
        while (used.has(unique.toLowerCase())) unique = name + " (" + k++ + ")";
        used.add(unique.toLowerCase());
        job.files.push({ path: r.file, name: unique + ".mp3", order: i });
      } else {
        job.failures.push({ title: v.title, reason: r.reason });
      }
      job.done++;
      job.updatedAt = Date.now();
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, videos.length) }, worker));

  job.files.sort((a, b) => a.order - b.order);
  job.updatedAt = Date.now();
  if (job.cancelled) { job.status = "cancelled"; removeDir(job.dir); return; }
  if (!job.files.length) { job.status = "error"; job.error = "None of the tracks could be converted. " + (job.failures[0] ? job.failures[0].reason : ""); removeDir(job.dir); return; }
  job.status = "done";
}

app.post("/api/audio/start", async (req, res) => {
  const t = await checkTools();
  if (!t.audio) return res.status(501).json({ error: "MP3 export needs yt-dlp and ffmpeg installed on the server. See the README." });

  const active = [...jobs.values()].filter(j => j.status === "running").length;
  if (active >= MAX_ACTIVE_JOBS) return res.status(429).json({ error: "The server is busy with other exports. Try again in a minute." });

  const bitrate = BITRATES.includes(+req.body.bitrate) ? +req.body.bitrate : 192;
  const numbered = req.body.numbered !== false;

  let pl;
  try { pl = await fetchPlaylist(req.body.url); }
  catch (e) { return res.status(e.status || 502).json({ error: e.message }); }
  if (!pl.videos.length) return res.status(404).json({ error: "No public videos found in this playlist." });
  if (pl.videos.length > MAX_TRACKS) return res.status(413).json({ error: "This playlist has " + pl.videos.length + " videos; the limit for MP3 export is " + MAX_TRACKS + "." });

  const id = crypto.randomBytes(12).toString("hex");
  const job = {
    id, title: pl.title, bitrate, numbered,
    dir: fs.mkdtempSync(path.join(os.tmpdir(), "sonovault-")),
    status: "running", total: pl.videos.length, done: 0,
    current: new Set(), files: [], failures: [], procs: new Set(),
    cancelled: false, error: "", updatedAt: Date.now()
  };
  jobs.set(id, job);
  runJob(job, pl.videos).catch(e => { job.status = "error"; job.error = e.message; });
  res.json({ id, total: job.total });
});

app.get("/api/audio/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Export not found or expired." });
  res.json({
    status: job.status, total: job.total, done: job.done,
    ok: job.files.length, failed: job.failures.length,
    failures: job.failures.slice(0, 20),
    current: [...job.current].slice(0, 3),
    error: job.error
  });
});

app.delete("/api/audio/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.json({ ok: true });
  if (job.status === "running") {
    job.cancelled = true;
    job.procs.forEach(p => p.kill());
  } else {
    removeDir(job.dir);
    jobs.delete(job.id);
  }
  res.json({ ok: true });
});

app.get("/api/audio/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send("Export not found or expired.");
  if (job.status !== "done") return res.status(409).send("Export isn't finished yet.");

  const base = safeName(job.title).slice(0, 80);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition",
    'attachment; filename="' + base.replace(/[^\x20-\x7e]/g, "_") + '.zip"; filename*=UTF-8\'\'' + encodeURIComponent(base) + ".zip");

  const zip = archiver("zip", { store: true });   // MP3 is already compressed
  zip.on("error", () => res.destroy());
  zip.pipe(res);
  job.files.forEach(f => zip.file(f.path, { name: f.name }));
  zip.finalize();
  res.on("finish", () => { removeDir(job.dir); jobs.delete(job.id); });
});

app.listen(PORT, async () => {
  console.log("Sonovault running at http://localhost:" + PORT);
  if (!API_KEY) console.warn("Warning: YOUTUBE_API_KEY is not set. Create a .env file (see .env.example).");
  const t = await checkTools();
  if (t.audio) console.log("MP3 export: ready (yt-dlp + ffmpeg found).");
  else console.warn("MP3 export: disabled. Missing " + [!t.ytdlp && "yt-dlp", !t.ffmpeg && "ffmpeg"].filter(Boolean).join(" and ") + ". See the README.");
});
