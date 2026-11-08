<p align="center"><img src="logo.png" alt="Sonovault" width="320"></p>

# Sonovault

*Your favorite playlists, archived securely as text and tone.*

Paste a YouTube playlist link and download every video title as a `.txt` file, or convert the whole playlist to MP3s in one `.zip`.

## Features

- Warm amber, vinyl-inspired UI with the Sonovault shield logo, an animated equalizer and a glow that pulses while a job runs
- Get every video title from a playlist of any length
- Scrollable track list with a live filter and an "Open" link per video
- Skips private and deleted videos
- Optional numbering and video links
- Download as `.txt` or copy to clipboard
- **Download all tracks as MP3s in one `.zip`** (128/192/256/320 kbps) with live progress and cancel

## Project structure

```
index.html     # page structure
style.css      # styling
logo.png       # full Sonovault logo (emblem, name and tagline)
logo-mark.png  # shield emblem only, transparent background (header, hero, footer)
favicon.png    # browser tab icon
apple-touch-icon.png  # home-screen icon on iOS
script.js      # front-end logic (track list, filter, download, copy)
server.js      # Node/Express server, reads .env, calls YouTube, runs yt-dlp + ffmpeg
package.json   # dependencies
.env.example   # template for your secret key and optional settings
```

## Setup

### 1. Install Node.js
Version 18 or newer. Check with `node -v`.

### 2. Get a YouTube Data API key
1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and sign in.
2. Create a new project (top bar, **New Project**).
3. Open **APIs & Services > Library**, search for **YouTube Data API v3** and click **Enable**.
4. Open **APIs & Services > Credentials**, click **Create Credentials > API key**, and copy the key.
5. (Recommended) Click the key, then under **API restrictions** choose **YouTube Data API v3** only.

### 3. Add the key to `.env`
In the project folder, copy the example file:

```bash
cp .env.example .env
```

Open `.env` and set the variable **`YOUTUBE_API_KEY`**:

```
YOUTUBE_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

No quotes, no spaces around `=`. You can also set `PORT` (default `3000`).

### 4. (For MP3 export) Install yt-dlp and ffmpeg
The text export works without these. The MP3 button is only enabled when the server finds both tools.

| OS | Commands |
| --- | --- |
| Windows | `winget install yt-dlp.yt-dlp` and `winget install Gyan.FFmpeg` |
| macOS | `brew install yt-dlp ffmpeg` |
| Linux | `sudo apt install ffmpeg` and `pip install -U yt-dlp` (or grab the binary from the yt-dlp releases page) |

Check with `yt-dlp --version` and `ffmpeg -version`. If they're not on your PATH, set `YTDLP_PATH` / `FFMPEG_PATH` in `.env`. Keep yt-dlp updated (`yt-dlp -U`), because YouTube changes often.

### 5. Install and run

```bash
npm install
npm start
```

Open **http://localhost:3000**, paste a playlist link, and click **Get video names**. Then use **Download .txt**, or pick a quality and click **Download MP3 .zip**.

## How the MP3 export works

1. The server re-reads the playlist through the YouTube Data API to get the video IDs.
2. For each video, **yt-dlp** requests YouTube's stream manifest and downloads only the best audio-only stream (Opus/AAC), not the video.
3. **ffmpeg** (LAME encoder) converts that audio to MP3 at the chosen bitrate and embeds title/artist metadata.
4. Up to 2 videos are processed at a time, tracked as a job in a temp folder. The page polls progress and can cancel.
5. When done, the MP3s are streamed back as a `.zip` (named after the playlist, files like `01 - Title.mp3`), and the temp files are deleted. Unfinished or unclaimed jobs are cleaned up after 30 minutes.

Videos that can't be converted (age-restricted, region-locked, removed) are skipped and counted in the result message.


## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Server is missing YOUTUBE_API_KEY" | Make sure the file is named exactly `.env` (not `.env.txt`), sits next to `server.js`, and you restarted the server. |
| "API key not valid" | Re-copy the key and check that YouTube Data API v3 is enabled for the project. |
| "Playlist not found" | The playlist must be public or unlisted. |
| MP3 button is disabled | yt-dlp and/or ffmpeg aren't installed or aren't on PATH. The server prints which one is missing at startup. |
| Tracks skipped / "Sign in to confirm you're not a bot" | Update yt-dlp, or export your browser cookies to a `cookies.txt` and set `COOKIES_FILE` in `.env`. |
| "limit for MP3 export" | Raise `MAX_AUDIO_TRACKS` in `.env`. |
| Quota exceeded | The free quota is 10,000 units per day. Each page of 50 videos costs about 1 unit. Try again tomorrow. |

## Tech

HTML, CSS, vanilla JavaScript, Node.js, Express, the YouTube Data API v3, yt-dlp, ffmpeg and archiver.

