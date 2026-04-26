import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  dismissInviteRoomFromState,
  emptyAppState,
  forgetRecentDmFromState,
  parseAppState,
} from "../src/store/app-state.js";
import { parseSession } from "../src/store/session.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

test("validates Matrix session shapes without touching real credentials", () => {
  assert.equal(parseSession(fixture("session-invalid.json")), null);
  assert.equal(parseSession("not an object"), null);
  assert.deepEqual(parseSession({
    accessToken: "token",
    baseUrl: "https://matrix.example.org",
    deviceId: "DEVICE",
    refreshToken: "refresh",
    userId: "@me:example.org",
  }), {
    accessToken: "token",
    baseUrl: "https://matrix.example.org",
    deviceId: "DEVICE",
    refreshToken: "refresh",
    userId: "@me:example.org",
  });
});

test("validates app state versions, recents, and malformed fields", () => {
  assert.deepEqual(emptyAppState(), {
    dismissedInviteRoomIds: [],
    recentDms: [],
    recentWorkspaces: [],
    version: 1,
  });
  assert.equal(parseAppState(fixture("state-invalid.json")), null);
  assert.deepEqual(parseAppState({
    lastOpenedAt: 3000,
    dismissedInviteRoomIds: ["!old-invite:example.org"],
    recentDms: [
      { name: "Bob", openedAt: 1000, roomId: "!dm:example.org" },
      { name: "Old Bob", openedAt: 500, roomId: "!dm:example.org" },
      { openedAt: "bad", roomId: "!bad:example.org" },
    ],
    recentWorkspaces: [
      { name: "Product", openedAt: 2000, spaceId: "!space:example.org" },
      { openedAt: 0, spaceId: "!bad-space:example.org" },
    ],
    version: 1,
  }), {
    lastOpenedAt: 3000,
    dismissedInviteRoomIds: ["!old-invite:example.org"],
    recentDms: [{ name: "Bob", openedAt: 1000, roomId: "!dm:example.org" }],
    recentWorkspaces: [{ name: "Product", openedAt: 2000, spaceId: "!space:example.org" }],
    version: 1,
  });
});

test("removes a forgotten DM from app state recents", () => {
  assert.deepEqual(forgetRecentDmFromState({
    dismissedInviteRoomIds: [],
    lastOpenedAt: 3000,
    recentDms: [
      { name: "Alice", openedAt: 1000, roomId: "!left:example.org" },
      { name: "Bob", openedAt: 2000, roomId: "!keep:example.org" },
    ],
    recentWorkspaces: [{ name: "Product", openedAt: 1500, spaceId: "!space:example.org" }],
    version: 1,
  }, "!left:example.org"), {
    dismissedInviteRoomIds: [],
    lastOpenedAt: 3000,
    recentDms: [{ name: "Bob", openedAt: 2000, roomId: "!keep:example.org" }],
    recentWorkspaces: [{ name: "Product", openedAt: 1500, spaceId: "!space:example.org" }],
    version: 1,
  });
});

test("records dismissed invite room IDs in app state", () => {
  assert.deepEqual(dismissInviteRoomFromState({
    dismissedInviteRoomIds: ["!old:example.org"],
    recentDms: [],
    recentWorkspaces: [],
    version: 1,
  }, "!new:example.org"), {
    dismissedInviteRoomIds: ["!new:example.org", "!old:example.org"],
    recentDms: [],
    recentWorkspaces: [],
    version: 1,
  });
});
