import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { MusicManager } from "./music-manager.js";
import { UserError, resolveYouTube } from "./resolvers.js";
import {
  errorView,
  queueView,
  queuedView,
  quietView,
  sessionEndedView,
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

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

/** Return the voice channel occupied by the member who sent an interaction. */
function userVoiceChannel(interaction) {
  return interaction.member?.voice?.channel || null;
}

/** Check that a member shares the bot's active voice channel. */
function sameVoiceChannel(interaction, state) {
  const userChannel = userVoiceChannel(interaction);
  return Boolean(userChannel && state.channelId === userChannel.id);
}

/** Explain why a member cannot control the player right now. */
function notInChannelView(state) {
  return errorView(
    state.channelId
      ? `Join <#${state.channelId}> to control playback.`
      : "I’m not in a voice channel. Start something with `/play`.",
  );
}

/** Skip the current track and build a reply describing what happens next. */
function skipReply(state, hadNext, userId) {
  if (!state.skip()) return quietView("There is no active track to skip.");
  return statusView(
    "⏭️  Skipped",
    hadNext
      ? `Skipped by <@${userId}> — loading the next track.`
      : `Skipped by <@${userId}> — that was the end of the queue.`,
  );
}

/** Handle a press on one of the now-playing card's buttons. */
async function handleButton(interaction, state) {
  const action = interaction.customId.slice("music:".length);
  if (
    !state.nowPlayingMessage ||
    interaction.message.id !== state.nowPlayingMessage.id
  ) {
    // Old cards keep their buttons after a restart; retire them on touch.
    await interaction.update({ components: [] });
    return void (await interaction.followUp({
      ...quietView(
        "That player has expired. Use `/nowplaying` for the live one.",
      ),
      ...EPHEMERAL,
    }));
  }
  if (action === "queue")
    return void (await interaction.reply({
      ...queueView(state),
      ...EPHEMERAL,
    }));
  if (!sameVoiceChannel(interaction, state))
    return void (await interaction.reply({
      ...notInChannelView(state),
      ...EPHEMERAL,
    }));

  if (action === "pause" || action === "resume") {
    if (action === "pause") state.pause();
    else state.resume();
    // Redraw the card itself so everyone sees the new state and button.
    await interaction.update(state.cardView());
  } else if (action === "skip") {
    // Skipping replaces this card synchronously, so answer privately.
    const hadNext = state.queue.length > 0;
    await interaction.reply({
      ...skipReply(state, hadNext, interaction.user.id),
      ...EPHEMERAL,
    });
  } else if (action === "stop") {
    state.nowPlayingMessage = null;
    state.stop();
    await interaction.update({
      ...sessionEndedView(interaction.user.id),
      components: [],
    });
  }
}

/** Handle `/play`: validate voice access, resolve the input, and queue it. */
async function handlePlay(interaction, state) {
  const voiceChannel = userVoiceChannel(interaction);
  if (!voiceChannel)
    return void (await interaction.reply({
      ...errorView("Join a voice channel first, then run `/play` again."),
      ...EPHEMERAL,
    }));
  if (state.current && state.channelId && state.channelId !== voiceChannel.id)
    return void (await interaction.reply({
      ...errorView(
        `I’m already playing in <#${state.channelId}>. Join that channel to add songs.`,
      ),
      ...EPHEMERAL,
    }));
  const me = interaction.guild.members.me;
  if (
    !me ||
    !voiceChannel
      .permissionsFor(me)
      .has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])
  )
    return void (await interaction.reply({
      ...errorView(
        `I need **Connect** and **Speak** permissions in <#${voiceChannel.id}>.`,
      ),
      ...EPHEMERAL,
    }));

  await interaction.deferReply();
  const input = interaction.options.getString("input", true).trim();
  const items = (await resolveYouTube(input, config)).map((item) => ({
    ...item,
    requestedBy: interaction.user.id,
  }));
  await state.connect(voiceChannel);
  const position = state.current ? state.queue.length + 1 : 0;
  await interaction.editReply(queuedView(items, position));
  // Enqueue after replying so the confirmation lands before the now-playing card.
  state.enqueue(items);
}

/** Handle the slash commands that control an existing session. */
async function handleCommand(interaction, state) {
  const name = interaction.commandName;
  if (name === "queue") return void (await interaction.reply(queueView(state)));
  if (name === "nowplaying") {
    if (!state.current)
      return void (await interaction.reply(
        quietView("Use `/play` with a YouTube link or song name."),
      ));
    // Move the live controls to this fresh card.
    state.retireCard();
    const response = await interaction.reply({
      ...state.cardView(),
      withResponse: true,
    });
    state.nowPlayingMessage = response.resource.message;
    return;
  }
  if (!sameVoiceChannel(interaction, state))
    return void (await interaction.reply({
      ...notInChannelView(state),
      ...EPHEMERAL,
    }));

  if (name === "pause") {
    const changed = state.pause();
    if (changed) state.refreshCard();
    await interaction.reply(
      changed
        ? statusView(
            "⏸️  Paused",
            `Paused by <@${interaction.user.id}>. Use \`/resume\` or the button to continue.`,
          )
        : quietView(
            state.paused
              ? "Playback is already paused."
              : "There is no active track to pause.",
          ),
    );
  } else if (name === "resume") {
    const changed = state.resume();
    if (changed) state.refreshCard();
    await interaction.reply(
      changed
        ? statusView("▶️  Resumed", `Resumed by <@${interaction.user.id}>.`)
        : quietView("Playback is not paused."),
    );
  } else if (name === "skip") {
    const hadNext = state.queue.length > 0;
    await interaction.reply(skipReply(state, hadNext, interaction.user.id));
  } else if (name === "stop") {
    state.stop();
    await interaction.reply(sessionEndedView(interaction.user.id));
  }
}

/** Show an error without letting a failed reply crash the process. */
async function replyWithError(interaction, error) {
  console.error("[command]", error);
  const message =
    error instanceof UserError
      ? error.message
      : "Something went wrong on my side. Try again in a moment.";
  try {
    if (interaction.deferred) await interaction.editReply(errorView(message));
    else if (interaction.replied)
      await interaction.followUp({ ...errorView(message), ...EPHEMERAL });
    else await interaction.reply({ ...errorView(message), ...EPHEMERAL });
  } catch (replyError) {
    console.error("[command] could not report error:", replyError.message);
  }
}

/** Route slash commands and transport-button interactions to a guild player. */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guild) return;
  const isMusicButton =
    interaction.isButton() && interaction.customId.startsWith("music:");
  if (!interaction.isChatInputCommand() && !isMusicButton) return;
  // Buttons keep their card's channel; only commands move where cards are posted.
  const state = manager.get(
    interaction.guild,
    isMusicButton ? undefined : interaction.channel,
  );

  try {
    if (isMusicButton) await handleButton(interaction, state);
    else if (interaction.commandName === "play")
      await handlePlay(interaction, state);
    else await handleCommand(interaction, state);
  } catch (error) {
    await replyWithError(interaction, error);
  }
});

/** Confirm successful login after the Discord gateway becomes ready. */
client.once(Events.ClientReady, () =>
  console.log(`Ready as ${client.user.tag}`),
);
client.login(process.env.DISCORD_TOKEN);

for (const signal of ["SIGINT", "SIGTERM"]) {
  /** Disconnect every guild cleanly when Docker or the terminal stops the bot. */
  process.once(signal, () => {
    for (const state of manager.guilds.values()) state.stop();
    client.destroy();
    process.exit(0);
  });
}
