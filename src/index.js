import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { MusicManager } from "./music-manager.js";
import { resolveYouTube } from "./resolvers.js";
import {
  errorView,
  nowPlayingView,
  queueView,
  queuedView,
  quietView,
  statusView,
} from "./ui.js";

const required = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length)
  throw new Error(
    `Missing required environment variables: ${missing.join(", ")}`,
  );

const config = {
  // Executable used to inspect and stream YouTube media.
  ytdlpPath: process.env.YTDLP_PATH || "yt-dlp",
  // Safety cap preventing very large playlists from flooding a server queue.
  maxPlaylistSize: Math.max(1, Number(process.env.MAX_PLAYLIST_SIZE) || 100),
  // Time the bot waits after the queue ends before leaving voice.
  idleDisconnectSeconds: Math.max(
    10,
    Number(process.env.IDLE_DISCONNECT_SECONDS) || 300,
  ),
};

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a YouTube link or search")
    .addStringOption((option) =>
      option
        .setName("input")
        .setDescription("YouTube link or song name")
        .setRequired(true),
    ),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Clear the queue and leave voice"),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the music queue"),
  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show the current song"),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
const route = process.env.DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(
      process.env.DISCORD_CLIENT_ID,
      process.env.DISCORD_GUILD_ID,
    )
  : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);
await rest.put(route, { body: commands });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const manager = new MusicManager({
  ytdlpPath: config.ytdlpPath,
  idleDisconnectSeconds: config.idleDisconnectSeconds,
  onError: (error) => console.error("[player]", error.message),
});

/** Return the voice channel occupied by the member who sent an interaction. */
function userVoiceChannel(interaction) {
  return interaction.member?.voice?.channel || null;
}

/** Check that a member shares the bot's active voice channel. */
function sameVoiceChannel(interaction, state) {
  const userChannel = userVoiceChannel(interaction);
  return (
    userChannel && state.connection?.joinConfig.channelId === userChannel.id
  );
}

/** Route slash commands and transport-button interactions to a guild player. */
client.on("interactionCreate", async (interaction) => {
  if (
    (!interaction.isChatInputCommand() && !interaction.isButton()) ||
    !interaction.guild
  )
    return;
  const state = manager.get(interaction.guild, interaction.channel);

  try {
    if (interaction.isButton()) {
      if (!interaction.customId.startsWith("music:")) return;
      if (!sameVoiceChannel(interaction, state)) {
        return void (await interaction.reply({
          ...errorView("Join my voice channel to use the player controls."),
          ephemeral: true,
        }));
      }
      const action = interaction.customId.slice("music:".length);
      if (action === "pause") {
        await interaction.reply({
          ...(state.pause()
            ? statusView(
                "Playback paused",
                "Press **Resume** when you’re ready.",
              )
            : quietView("There is no active track to pause.")),
          ephemeral: true,
        });
      } else if (action === "resume") {
        await interaction.reply({
          ...(state.resume()
            ? statusView("Back on air", "Playback has resumed.")
            : quietView("Playback is not paused.")),
          ephemeral: true,
        });
      } else if (action === "skip") {
        const hadNext = state.queue.length > 0;
        await interaction.reply({
          ...(state.skip()
            ? statusView(
                "Track skipped",
                hadNext
                  ? "Loading the next track."
                  : "That was the end of the queue.",
              )
            : quietView("There is no active track to skip.")),
          ephemeral: true,
        });
      } else if (action === "stop") {
        state.stop();
        await interaction.update({
          ...statusView(
            "Session ended",
            "Queue cleared • Disconnected from voice",
          ),
          components: [],
        });
      } else if (action === "queue") {
        await interaction.reply({ ...queueView(state), ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === "play") {
      const voiceChannel = userVoiceChannel(interaction);
      if (!voiceChannel)
        return void (await interaction.reply({
          ...errorView("Join a voice channel first, then run `/play` again."),
          ephemeral: true,
        }));
      if (
        !voiceChannel
          .permissionsFor(interaction.guild.members.me)
          .has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])
      )
        return void (await interaction.reply({
          ...errorView(
            "Give me **Connect** and **Speak** permissions in your voice channel.",
          ),
          ephemeral: true,
        }));

      await interaction.deferReply();
      const input = interaction.options.getString("input", true).trim();
      const items = await resolveYouTube(input, config);
      await state.connect(voiceChannel);
      const position = state.current ? state.queue.length + 1 : 1;
      state.enqueue(items);
      await interaction.editReply(queuedView(items, position));
      return;
    }

    if (!sameVoiceChannel(interaction, state)) {
      return void (await interaction.reply({
        ...errorView("Join my voice channel to control playback."),
        ephemeral: true,
      }));
    }
    if (interaction.commandName === "pause") {
      await interaction.reply(
        state.pause()
          ? statusView("Playback paused", "Use `/resume` when you’re ready.")
          : quietView("There is no active track to pause."),
      );
    } else if (interaction.commandName === "resume") {
      await interaction.reply(
        state.resume()
          ? statusView("Back on air", "Playback has resumed.")
          : quietView("Playback is not paused."),
      );
    } else if (interaction.commandName === "skip") {
      const hadNext = state.queue.length > 0;
      await interaction.reply(
        state.skip()
          ? statusView(
              "Track skipped",
              hadNext
                ? "Loading the next track."
                : "That was the end of the queue.",
            )
          : quietView("There is no active track to skip."),
      );
    } else if (interaction.commandName === "stop") {
      state.stop();
      await interaction.reply(
        statusView("Session ended", "Queue cleared • Disconnected from voice"),
      );
    } else if (interaction.commandName === "nowplaying") {
      await interaction.reply(
        state.current
          ? nowPlayingView(state.current, state.queue.length)
          : quietView("Use `/play` with a YouTube link or song name."),
      );
    } else if (interaction.commandName === "queue") {
      await interaction.reply(queueView(state));
    }
  } catch (error) {
    console.error("[command]", error);
    const message = String(error.message || "Something went wrong.").slice(
      0,
      1000,
    );
    if (interaction.deferred || interaction.replied)
      await interaction.editReply(errorView(message));
    else await interaction.reply({ ...errorView(message), ephemeral: true });
  }
});

/** Confirm successful login after the Discord gateway becomes ready. */
client.once("ready", () => console.log(`Ready as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);

for (const signal of ["SIGINT", "SIGTERM"]) {
  /** Disconnect every guild cleanly when Docker or the terminal stops the bot. */
  process.once(signal, () => {
    for (const state of manager.guilds.values()) state.stop();
    client.destroy();
    process.exit(0);
  });
}
