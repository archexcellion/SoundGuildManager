import test from "node:test";
import assert from "node:assert/strict";
import { classifyInput, formatDuration } from "../src/resolvers.js";

test("classifies supported links and searches", () => {
  assert.equal(classifyInput("https://youtu.be/abc").type, "youtube");
  assert.equal(
    classifyInput("https://music.youtube.com/watch?v=abc").type,
    "youtube",
  );
  assert.deepEqual(classifyInput("Daft Punk One More Time"), {
    type: "search",
    value: "Daft Punk One More Time",
  });
});

test("rejects unrelated URLs", () => {
  assert.throws(
    () => classifyInput("https://open.spotify.com/track/abc"),
    /Only YouTube/,
  );
  assert.throws(
    () => classifyInput("https://example.com/song"),
    /Only YouTube/,
  );
});

test("formats duration", () => {
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(null), "?:??");
});
