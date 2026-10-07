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
import { UserError, friendlyError } from "./resolvers.js";
import { nowPlayingView, trackFailedView } from "./ui.js";

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

  /** Report whether a user paused playback (Discord's auto-pause resumes itself). */
  get paused() {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  /** Report the voice channel the bot is connected to, if any. */
  get channelId() {
    return this.connection?.joinConfig.channelId || null;
  }

  /** Redraw the now-playing card so its controls and queue info stay current. */
  refreshCard() {
    if (!this.current || !this.nowPlayingMessage) return;
    this.nowPlayingMessage
      .edit(this.cardView())
      .catch((error) => this.onError(error));
  }

  /** Build the now-playing card for the current state. */
  cardView() {
    return nowPlayingView(this.current, {
      queue: this.queue,
      paused: this.paused,
    });
  }

  /** Remove the controls from the last now-playing card so it cannot be reused. */
  retireCard() {
    this.nowPlayingMessage?.edit({ components: [] }).catch(() => {});
    this.nowPlayingMessage = null;
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
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      this.connection?.destroy();
      this.connection = null;
      throw new UserError(
        `I couldn’t connect to <#${channel.id}>. Check my permissions and try again.`,
      );
    }
  }

  /** Add resolved tracks and begin playback when the player is idle. */
  enqueue(items) {
    this.queue.push(...items);
    clearTimeout(this.idleTimer);
    if (!this.current && this.player.state.status === AudioPlayerStatus.Idle)
      this.advance();
    else this.refreshCard();
  }

  /** Stop the old stream, take the next track, and create its audio pipeline. */
  advance() {
    this.killProcesses();
    this.current = this.queue.shift() || null;
    this.retireCard();
    if (!this.current) {
      this.scheduleDisconnect();
      return;
    }
    const item = this.current;

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
        item.url,
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
    // Ignore EPIPE when FFmpeg is killed before yt-dlp finishes writing.
    ffmpeg.stdin.on("error", () => {});
    const stderr = [];
    downloader.stderr.on("data", (chunk) => stderr.push(chunk));
    downloader.once("close", (code) => {
      // A null code means we killed it on skip/stop; only real failures count.
      if (!code) return;
      const detail = Buffer.concat(stderr).toString().trim();
      this.onError(new Error(detail || `yt-dlp exited with code ${code}`));
      this.textChannel
        .send(trackFailedView(item, friendlyError(detail)))
        .catch((error) => this.onError(error));
    });
    downloader.once("error", (error) => this.onError(error));
    ffmpeg.once("error", (error) => this.onError(error));
    this.processes = [downloader, ffmpeg];

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
    });
    this.player.play(resource);
    this.textChannel
      .send(this.cardView())
      .then((message) => {
        // The track may have ended while the card was still being sent.
        if (this.current === item) this.nowPlayingMessage = message;
        else message.edit({ components: [] }).catch(() => {});
      })
      .catch((error) => this.onError(error));
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
    this.retireCard();
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

  /** Return a server's player, creating it and updating its response channel when given. */
  get(guild, textChannel) {
    let state = this.guilds.get(guild.id);
    if (!state) {
      state = new GuildPlayer({ ...this.options, guild, textChannel });
      this.guilds.set(guild.id, state);
    } else if (textChannel) {
      state.textChannel = textChannel;
    }
    return state;
  }
}
