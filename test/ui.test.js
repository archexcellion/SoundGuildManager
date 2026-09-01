import test from "node:test";
import assert from "node:assert/strict";
import { nowPlayingView, queueView } from "../src/ui.js";

const item = {
  title: "Midnight City",
  url: "https://www.youtube.com/watch?v=dX3k_QDnzHE",
  duration: 244,
  thumbnail: "https://i.ytimg.com/vi/dX3k_QDnzHE/hqdefault.jpg",
};

test("now-playing view includes artwork and five controls", () => {
  const view = nowPlayingView(item, 2);
  const embed = view.embeds[0].toJSON();
  assert.equal(embed.title, item.title);
  assert.equal(embed.thumbnail.url, item.thumbnail);
  assert.equal(view.components[0].components.length, 5);
});

test("queue view shows current and upcoming tracks", () => {
  const embed = queueView({ current: item, queue: [item] }).embeds[0].toJSON();
  assert.match(embed.description, /NOW PLAYING/);
  assert.equal(embed.fields[0].name, "UP NEXT");
});
