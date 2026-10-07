import test from "node:test";
import assert from "node:assert/strict";
import { nowPlayingView, queueView, queuedView } from "../src/ui.js";

const item = {
  title: "Midnight City",
  url: "https://www.youtube.com/watch?v=dX3k_QDnzHE",
  duration: 244,
  thumbnail: "https://i.ytimg.com/vi/dX3k_QDnzHE/hqdefault.jpg",
  requestedBy: "123",
};

/** Return the custom IDs of a view's control buttons. */
function buttonIds(view) {
  return view.components[0].toJSON().components.map((b) => b.custom_id);
}

test("now-playing view includes artwork, requester, and next track", () => {
  const view = nowPlayingView(item, { queue: [{ ...item, title: "Wait" }] });
  const embed = view.embeds[0].toJSON();
  assert.equal(embed.title, item.title);
  assert.equal(embed.thumbnail.url, item.thumbnail);
  const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(fields["Requested by"], "<@123>");
  assert.match(fields["Up next"], /Wait/);
  assert.equal(view.components[0].components.length, 4);
});

test("controls toggle between pause and resume", () => {
  assert.deepEqual(buttonIds(nowPlayingView(item)), [
    "music:pause",
    "music:skip",
    "music:queue",
    "music:stop",
  ]);
  assert.equal(
    buttonIds(nowPlayingView(item, { paused: true }))[0],
    "music:resume",
  );
});

test("every control button uses a real emoji", () => {
  for (const button of nowPlayingView(item).components[0].toJSON().components)
    assert.match(button.emoji.name, /^\p{Extended_Pictographic}/u);
});

test("queue view shows current and upcoming tracks", () => {
  const embed = queueView({ current: item, queue: [item] }).embeds[0].toJSON();
  assert.match(embed.description, /Now playing/);
  assert.match(embed.description, /Up next/);
  assert.match(embed.footer.text, /1 track waiting/);
});

test("queue view escapes markdown and stays within embed limits", () => {
  const noisy = { ...item, title: "*_~`|".repeat(60) };
  const embed = queueView({
    current: noisy,
    queue: Array(25).fill(noisy),
  }).embeds[0].toJSON();
  assert.ok(embed.description.length <= 4096, `${embed.description.length}`);
  assert.match(embed.description, /\\\*/);
  assert.match(embed.footer.text, /15 more not shown/);
});

test("queued view distinguishes starting now from waiting", () => {
  assert.match(
    queuedView([item], 0).embeds[0].toJSON().author.name,
    /Starting now/,
  );
  assert.match(queuedView([item], 3).embeds[0].toJSON().description, /#3/);
  const playlist = queuedView([item, { ...item, duration: null }], 2);
  assert.match(playlist.embeds[0].toJSON().description, /Total 4:04\+/);
});

test("noisy titles never exceed embed title limits", () => {
  const noisy = { ...item, title: "*_~`|[".repeat(200) };
  for (const view of [
    nowPlayingView(noisy, { queue: [noisy] }),
    queuedView([noisy], 0),
    queuedView([noisy, noisy], 1),
  ]) {
    const embed = view.embeds[0].toJSON();
    assert.ok((embed.title ?? "").length <= 256);
    assert.ok((embed.description ?? "").length <= 4096);
  }
});

test("brackets in titles are escaped inside track links", () => {
  const view = nowPlayingView(item, {
    queue: [{ ...item, title: "Song [Official Video]" }],
  });
  const upNext = view.embeds[0].toJSON().fields.at(-1).value;
  assert.match(upNext, /^\[Song \\\[Official Video\\\]\]\(/);
});
