import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
} from "discord.js";
import { formatDuration } from "./resolvers.js";

const COLORS = {
  violet: 0x8b5cf6,
  amber: 0xf59e0b,
  cyan: 0x22d3ee,
  coral: 0xfb7185,
  slate: 0x64748b,
};

const QUEUE_PAGE_SIZE = 10;
const BRAND = "SoundGuildManager";

/** Keep external titles within Discord limits and stop them breaking markdown. */
function trimmed(value, length, { inLink = false } = {}) {
  if (!value) return "Unknown title";
  // Escape first so the length cap includes the added backslashes.
  let escaped = escapeMarkdown(value);
  // Brackets only matter inside [link text](url), e.g. "Song [Official Video]".
  if (inLink) escaped = escaped.replace(/[[\]]/g, "\\$&");
  if (escaped.length <= length) return escaped;
  return `${escaped.slice(0, length - 1).replace(/\\+$/, "")}…`;
}

/** Pluralize a count of tracks. */
function tracks(count) {
  return `${count} track${count === 1 ? "" : "s"}`;
}

/** Sum known durations, flagging when some tracks have no length. */
function totalDuration(items) {
  const known = items.filter((item) => Number.isFinite(item.duration));
  const seconds = known.reduce((sum, item) => sum + item.duration, 0);
  const text = formatDuration(seconds);
  return known.length < items.length ? `${text}+` : text;
}

/** Render a markdown link to a track, with the title escaped and trimmed. */
function trackLink(item, length) {
  return `[${trimmed(item.title, length, { inLink: true })}](${item.url})`;
}

/** Mention the member who queued a track, if known. Mentions in embeds never ping. */
function requester(item) {
  return item.requestedBy ? `<@${item.requestedBy}>` : "—";
}

/** Build the playback control row, showing Pause or Resume to match the player. */
export function controls({ paused = false } = {}) {
  return new ActionRowBuilder().addComponents(
    paused
      ? new ButtonBuilder()
          .setCustomId("music:resume")
          .setEmoji("▶️")
          .setLabel("Resume")
          .setStyle(ButtonStyle.Success)
      : new ButtonBuilder()
          .setCustomId("music:pause")
          .setEmoji("⏸️")
          .setLabel("Pause")
          .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music:skip")
      .setEmoji("⏭️")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("music:queue")
      .setEmoji("📜")
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
export function nowPlayingView(item, { queue = [], paused = false } = {}) {
  const next = queue[0];
  const embed = new EmbedBuilder()
    .setColor(paused ? COLORS.amber : COLORS.violet)
    .setAuthor({ name: paused ? "⏸️  Paused" : "🎶  Now playing" })
    .setTitle(trimmed(item.title, 250))
    .setURL(item.url)
    .addFields(
      { name: "Length", value: formatDuration(item.duration), inline: true },
      { name: "Requested by", value: requester(item), inline: true },
      { name: "In queue", value: tracks(queue.length), inline: true },
      {
        name: "Up next",
        value: next
          ? `${trackLink(next, 200)} · ${formatDuration(next.duration)}`
          : "Nothing yet — add more with `/play`",
      },
    )
    .setFooter({ text: `${BRAND} • YouTube audio` });
  if (item.thumbnail) embed.setThumbnail(item.thumbnail);
  return { embeds: [embed], components: [controls({ paused })] };
}

/**
 * Build confirmation UI for a queued video or playlist.
 * `position` is the 1-based spot of the first added track; 0 means it plays now.
 */
export function queuedView(items, position) {
  const first = items[0];
  const startsNow = position === 0;
  const embed = new EmbedBuilder()
    .setColor(COLORS.cyan)
    .setFooter({ text: `${BRAND} • YouTube audio` });

  if (items.length === 1) {
    embed
      .setAuthor({
        name: startsNow ? "▶️  Starting now" : "➕  Added to queue",
      })
      .setTitle(trimmed(first.title, 250))
      .setURL(first.url)
      .setDescription(
        [
          startsNow ? "Up first" : `**#${position}** in queue`,
          formatDuration(first.duration),
          `requested by ${requester(first)}`,
        ].join("  •  "),
      );
  } else {
    embed
      .setAuthor({ name: "➕  Playlist added" })
      .setTitle(`${tracks(items.length)} added`)
      .setDescription(
        [
          `${startsNow ? "Starting with" : "First up"} ${trackLink(first, 180)}`,
          `Total ${totalDuration(items)}  •  ${
            startsNow ? "playing now" : `from **#${position}** in queue`
          }  •  requested by ${requester(first)}`,
        ].join("\n"),
      );
  }
  if (first.thumbnail) embed.setThumbnail(first.thumbnail);
  return { embeds: [embed] };
}

/** Build a compact view of the active track and the next page of the queue. */
export function queueView(state) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.violet)
    .setAuthor({ name: "📜  Queue" });

  const lines = [];
  if (state.current) {
    lines.push(
      `**Now playing** · ${trackLink(state.current, 120)} · ${formatDuration(state.current.duration)}`,
    );
    if (state.current.thumbnail) embed.setThumbnail(state.current.thumbnail);
  } else {
    embed.setTitle("Nothing playing");
    lines.push("Use `/play` with a YouTube link or song name to start.");
  }

  if (state.queue.length) {
    lines.push("", "**Up next**");
    // The list lives in the description (4096-char limit) so long, escaped
    // titles cannot overflow a 1024-char field.
    for (const [index, item] of state.queue
      .slice(0, QUEUE_PAGE_SIZE)
      .entries()) {
      lines.push(
        `\`${String(index + 1).padStart(2, " ")}\` ${trackLink(item, 70)} · ${formatDuration(item.duration)}`,
      );
    }
  }
  embed.setDescription(lines.join("\n"));

  const hidden = Math.max(0, state.queue.length - QUEUE_PAGE_SIZE);
  const footer = state.queue.length
    ? [
        `${tracks(state.queue.length)} waiting`,
        `${totalDuration(state.queue)} total`,
        hidden ? `${hidden} more not shown` : null,
      ]
    : ["Queue is empty"];
  embed.setFooter({ text: footer.filter(Boolean).join(" • ") });
  return { embeds: [embed] };
}

/** Build the base card used for short playback status messages. */
export function statusView(title, description, color = COLORS.cyan) {
  const embed = new EmbedBuilder().setColor(color).setTitle(title);
  if (description) embed.setDescription(description);
  return { embeds: [embed] };
}

/** Build a coral error card that explains how to recover. */
export function errorView(message) {
  return statusView("⚠️  Couldn’t do that", message, COLORS.coral);
}

/** Build a neutral empty-state card when no track can be controlled. */
export function quietView(message) {
  return statusView("Nothing playing", message, COLORS.slate);
}

/** Build the notice posted when a track fails mid-stream and is skipped. */
export function trackFailedView(item, reason) {
  return statusView(
    "⚠️  Skipped a track",
    `Couldn’t play ${trackLink(item, 200)}.\n${reason}`,
    COLORS.coral,
  );
}

/** Build the card that replaces the player once a session ends. */
export function sessionEndedView(userId) {
  return statusView(
    "⏹️  Session ended",
    `Queue cleared and disconnected from voice${userId ? ` by <@${userId}>` : ""}.`,
    COLORS.slate,
  );
}
