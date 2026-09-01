import { spawn } from "node:child_process";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

/** Classify a YouTube URL or treat plain text as a YouTube search query. */
export function classifyInput(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return { type: "search", value: input.trim() };
  }

  const hostname = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(hostname))
    return { type: "youtube", value: url.toString() };
  throw new Error(
    "Only YouTube links are supported. You can also enter a song name.",
  );
}

/** Run yt-dlp and parse its single JSON document, preserving useful errors. */
function runJson(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) =>
      reject(new Error(`Could not start ${command}: ${error.message}`)),
    );
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString().trim();
        reject(new Error(detail || `${command} exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString()));
      } catch {
        reject(new Error(`${command} returned invalid metadata.`));
      }
    });
  });
}

/** Convert yt-dlp metadata into a stable, playable YouTube watch URL. */
function youtubeWatchUrl(entry) {
  if (entry.webpage_url?.startsWith("http")) return entry.webpage_url;
  if (entry.url?.startsWith("http")) return entry.url;
  return `https://www.youtube.com/watch?v=${entry.id}`;
}

/** Resolve a video, playlist, or search into normalized queue items. */
export async function resolveYouTube(input, { ytdlpPath, maxPlaylistSize }) {
  const classified = classifyInput(input);
  const target =
    classified.type === "search"
      ? `ytsearch1:${classified.value}`
      : classified.value;
  const data = await runJson(ytdlpPath, [
    "--ignore-config",
    "--dump-single-json",
    "--flat-playlist",
    "--no-warnings",
    "--playlist-end",
    String(maxPlaylistSize),
    "--",
    target,
  ]);

  const entries = Array.isArray(data.entries)
    ? data.entries.filter(Boolean)
    : [data];
  if (!entries.length)
    throw new Error("No playable YouTube results were found.");

  return entries.slice(0, maxPlaylistSize).map((entry) => ({
    title: entry.title || "Unknown title",
    url: youtubeWatchUrl(entry),
    duration: Number(entry.duration) || null,
    thumbnail: entry.thumbnail || entry.thumbnails?.at(-1)?.url || null,
    source: "YouTube",
  }));
}

/** Format seconds as Discord-friendly minutes and seconds. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "?:??";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
