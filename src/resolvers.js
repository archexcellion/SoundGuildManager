import { spawn } from "node:child_process";

/** An error whose message is safe and helpful to show in Discord. */
export class UserError extends Error {}

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
  // Text like "lofi: chill beats" parses as a URL with a "lofi:" scheme.
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { type: "search", value: input.trim() };

  const hostname = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(hostname))
    return { type: "youtube", value: url.toString() };
  throw new UserError(
    "Only YouTube links are supported. You can also enter a song name.",
  );
}

const FRIENDLY_ERRORS = [
  [
    /sign in to confirm you.re not a bot|http error 429|too many requests/i,
    "YouTube is rate-limiting me right now. Try again in a few minutes.",
  ],
  [
    /age.restricted|confirm your age|inappropriate for some users/i,
    "That video is age-restricted, so I can’t play it.",
  ],
  [/private video/i, "That video is private."],
  [
    /members.only|join this channel/i,
    "That video is for channel members only.",
  ],
  [
    /not available in your country|geo.?restrict/i,
    "That video isn’t available in my region.",
  ],
  [/live event will begin|premieres? in/i, "That stream hasn’t started yet."],
  [
    /playlist does not exist|unable to recognize playlist/i,
    "That playlist doesn’t exist or is private.",
  ],
  [
    /video unavailable|has been removed|does not exist|not available/i,
    "That video is unavailable.",
  ],
  [
    /could not start/i,
    "The YouTube downloader isn’t installed correctly. Ask the bot owner to check `yt-dlp`.",
  ],
];

/** Turn raw yt-dlp output into a short message suitable for Discord users. */
export function friendlyError(detail) {
  const text = String(detail || "");
  for (const [pattern, message] of FRIENDLY_ERRORS)
    if (pattern.test(text)) return message;
  return "YouTube didn’t return anything I can play. Check the link or try another search.";
}

/** Run yt-dlp and parse its single JSON document, preserving useful errors. */
function runJson(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      console.error("[yt-dlp]", error.message);
      reject(new UserError(friendlyError(`could not start ${command}`)));
    });
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString().trim();
        console.error("[yt-dlp]", detail || `exited with code ${code}`);
        reject(new UserError(friendlyError(detail)));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString()));
      } catch {
        reject(new UserError(friendlyError("")));
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
    throw new UserError("No YouTube results matched that search.");

  return entries.slice(0, maxPlaylistSize).map((entry) => ({
    title: entry.title || "Unknown title",
    url: youtubeWatchUrl(entry),
    duration: Number(entry.duration) || null,
    thumbnail: entry.thumbnail || entry.thumbnails?.at(-1)?.url || null,
    source: "YouTube",
  }));
}

/** Format seconds as Discord-friendly h:mm:ss or m:ss. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "?:??";
  const pad = (value) => String(Math.floor(value)).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours
    ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
    : `${minutes}:${pad(seconds % 60)}`;
}
