import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { formatDuration } from "./resolvers.js";

const COLORS = {
  violet: 0x8b5cf6,
  cyan: 0x22d3ee,
  coral: 0xfb7185,
  slate: 0x64748b,
};

/** Keep external titles within Discord embed field limits. */
function trimmed(value, length) {
  if (!value) return "Unknown title";
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

/** Build the reusable five-button playback control row. */
export function controls() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music:pause")
      .setEmoji("⏸️")
      .setLabel("Pause")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music:resume")
      .setEmoji("▶️")
      .setLabel("Resume")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("music:skip")
      .setEmoji("⏭️")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("music:queue")
      .setEmoji("≡")
      .setLabel("Queue")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music:stop")
      .setEmoji("⏹️")
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger),
  );
}

/** Build the artwork-rich card shown whenever a track starts. */
export function nowPlayingView(item, queueLength) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.violet)
    .setAuthor({ name: "SGM  •  NOW PLAYING" })
    .setTitle(trimmed(item.title, 250))
    .setURL(item.url)
    .addFields(
      {
        name: "LENGTH",
        value: `\`${formatDuration(item.duration)}\``,
        inline: true,
      },
      { name: "SOURCE", value: "`YouTube`", inline: true },
      {
        name: "UP NEXT",
        value: `\`${queueLength} track${queueLength === 1 ? "" : "s"}\``,
        inline: true,
      },
    )
    .setFooter({
      text: "SoundGuildManager • I leave after the queue is idle",
    });
  if (item.thumbnail) embed.setThumbnail(item.thumbnail);
  return { embeds: [embed], components: [controls()] };
}

/** Build confirmation UI for a queued video or playlist. */
export function queuedView(items, position) {
  const single = items.length === 1;
  const embed = new EmbedBuilder()
    .setColor(COLORS.cyan)
    .setAuthor({ name: "SGM  •  ADDED" })
    .setTitle(
      single ? trimmed(items[0].title, 250) : `${items.length} tracks added`,
    )
    .setDescription(
      single
        ? `Queue position \`${position}\`  •  ${formatDuration(items[0].duration)}`
        : `The playlist is ready. First up: **${trimmed(items[0].title, 180)}**`,
    )
    .setFooter({ text: "SoundGuildManager • YouTube audio" });
  if (single) embed.setURL(items[0].url);
  if (items[0].thumbnail) embed.setThumbnail(items[0].thumbnail);
  return { embeds: [embed] };
}

/** Build a compact view of the active track and first ten queued tracks. */
export function queueView(state) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.violet)
    .setAuthor({ name: "SGM  •  QUEUE" });

  if (state.current) {
    embed
      .setTitle(trimmed(state.current.title, 250))
      .setURL(state.current.url)
      .setDescription(
        `**NOW PLAYING**  •  ${formatDuration(state.current.duration)}`,
      );
    if (state.current.thumbnail) embed.setThumbnail(state.current.thumbnail);
  } else {
    embed
      .setTitle("The booth is quiet")
      .setDescription(
        "Use `/play` with a YouTube link or song name to start listening.",
      );
  }

  if (state.queue.length) {
    const lines = state.queue
      .slice(0, 10)
      .map(
        (item, index) =>
          `\`${String(index + 1).padStart(2, "0")}\`  ${trimmed(item.title, 70)}  ·  ${formatDuration(item.duration)}`,
      );
    embed.addFields({ name: "UP NEXT", value: lines.join("\n") });
  }
  const hidden = Math.max(0, state.queue.length - 10);
  embed.setFooter({
    text: hidden
      ? `${hidden} more tracks not shown`
      : `${state.queue.length} track${state.queue.length === 1 ? "" : "s"} waiting`,
  });
  return { embeds: [embed] };
}

/** Build the base card used for short playback status messages. */
export function statusView(title, description, color = COLORS.cyan) {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: "SGM  •  SOUNDGUILDMANAGER" })
        .setTitle(title)
        .setDescription(description),
    ],
  };
}

/** Build a coral error card that explains how to recover. */
export function errorView(message) {
  return statusView("Couldn’t do that", message, COLORS.coral);
}

/** Build a neutral empty-state card when no track can be controlled. */
export function quietView(message) {
  return statusView("Nothing playing", message, COLORS.slate);
}
