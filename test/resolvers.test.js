import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyInput,
  formatDuration,
  friendlyError,
} from "../src/resolvers.js";

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
  assert.equal(classifyInput("lofi: chill beats").type, "search");
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
  assert.equal(formatDuration(3725), "1:02:05");
});

test("maps yt-dlp errors to friendly messages", () => {
  assert.match(
    friendlyError("ERROR: [youtube] abc: Sign in to confirm you’re not a bot"),
    /rate-limiting/,
  );
  assert.match(friendlyError("ERROR: [youtube] abc: Private video"), /private/);
  assert.match(
    friendlyError("ERROR: [youtube:tab] The playlist does not exist."),
    /playlist/,
  );
  assert.match(
    friendlyError("ERROR: [youtube] abc: Video unavailable"),
    /unavailable/,
  );
  assert.match(friendlyError("something odd"), /Check the link/);
});
