import { spawn } from "node:child_process";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import ffmpegPath from "ffmpeg-static";
import { nowPlayingView } from "./ui.js";

export class GuildPlayer {
  /** Create the queue, voice player, and process state for one Discord server. */
  constructor({
    guild,
    textChannel,
    ytdlpPath,
    idleDisconnectSeconds,
    onError,
  }) {
    this.guild = guild;
    this.textChannel = textChannel;
    this.ytdlpPath = ytdlpPath;
    this.idleDisconnectSeconds = idleDisconnectSeconds;
    this.onError = onError;
    this.queue = [];
    this.current = null;
    this.connection = null;
    this.processes = [];
    this.nowPlayingMessage = null;
    this.idleTimer = null;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.player.on(AudioPlayerStatus.Idle, () => this.advance());
    this.player.on("error", (error) => {
      this.onError(error);
    });
  }

  /** Join or move to a voice channel and wait until Discord reports it ready. */
  async connect(channel) {
    clearTimeout(this.idleTimer);
    if (this.connection?.joinConfig.channelId === channel.id) return;
    this.connection?.destroy();
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    this.connection.subscribe(this.player);
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.stop();
      }
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
  }

  /** Add resolved tracks and begin playback when the player is idle. */
  enqueue(items) {
    this.queue.push(...items);
    clearTimeout(this.idleTimer);
    if (!this.current && this.player.state.status === AudioPlayerStatus.Idle)
      this.advance();
  }

  /** Stop the old stream, take the next track, and create its audio pipeline. */
  advance() {
    this.killProcesses();
    this.current = this.queue.shift() || null;
    if (!this.current) {
      this.nowPlayingMessage?.edit({ components: [] }).catch(() => {});
      this.nowPlayingMessage = null;
      this.scheduleDisconnect();
      return;
    }

    const downloader = spawn(
      this.ytdlpPath,
      [
        "--ignore-config",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "-f",
        "bestaudio/best",
        "-o",
        "-",
        "--",
        this.current.url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const ffmpeg = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    downloader.stdout.pipe(ffmpeg.stdin);
    downloader.stderr.on("data", (chunk) =>
      this.onError(new Error(chunk.toString().trim())),
    );
    downloader.once("error", (error) => this.onError(error));
    ffmpeg.once("error", (error) => this.onError(error));
    this.processes = [downloader, ffmpeg];

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
    });
    this.player.play(resource);
    this.nowPlayingMessage?.edit({ components: [] }).catch(() => {});
    this.textChannel
      .send(nowPlayingView(this.current, this.queue.length))
      .then((message) => {
        this.nowPlayingMessage = message;
      })
      .catch(() => {});
  }

  /** Pause the current Discord audio player, returning whether it changed state. */
  pause() {
    return this.player.pause();
  }
  /** Resume a paused Discord audio player, returning whether it changed state. */
  resume() {
    return this.player.unpause();
  }
  /** End the current resource so the idle listener advances to the next track. */
  skip() {
    if (!this.current) return false;
    this.player.stop(true);
    return true;
  }

  /** Clear playback, retire controls, terminate streams, and leave voice. */
  stop() {
    this.queue.length = 0;
    this.current = null;
    this.player.stop(true);
    this.killProcesses();
    this.connection?.destroy();
    this.connection = null;
    this.nowPlayingMessage?.edit({ components: [] }).catch(() => {});
    this.nowPlayingMessage = null;
    clearTimeout(this.idleTimer);
  }

  /** Terminate yt-dlp and FFmpeg children belonging to the current track. */
  killProcesses() {
    for (const child of this.processes) {
      if (!child.killed) child.kill("SIGKILL");
    }
    this.processes = [];
  }

  /** Start the configurable idle timer that releases the voice connection. */
  scheduleDisconnect() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.connection?.destroy();
      this.connection = null;
    }, this.idleDisconnectSeconds * 1000);
    this.idleTimer.unref();
  }
}

export class MusicManager {
  /** Store independent GuildPlayer instances by Discord server ID. */
  constructor(options) {
    this.options = options;
    this.guilds = new Map();
  }

  /** Return a server's player, creating it and updating its response channel. */
  get(guild, textChannel) {
    let state = this.guilds.get(guild.id);
    if (!state) {
      state = new GuildPlayer({ ...this.options, guild, textChannel });
      this.guilds.set(guild.id, state);
    } else {
      state.textChannel = textChannel;
    }
    return state;
  }
}
