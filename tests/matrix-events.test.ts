import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { EventType, MatrixEvent, RoomCreateTypeField, RoomType } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import type { Room } from "matrix-js-sdk";

import {
  getBundledThreadReplyCount,
  getThreadReplyRootEventId,
  getThreadRootForEvent,
  isThreadReply,
  loadThreadEvents,
} from "../src/matrix/threads.js";
import {
  getJoinedDirectRooms,
  getJoinedRooms,
  getPendingDirectRoomInvites,
  getRoomDisplayName,
  isSpaceRoom,
} from "../src/matrix/rooms.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

function event(raw: unknown): MatrixEvent {
  return new MatrixEvent(raw);
}

test("detects Matrix thread replies and root IDs", () => {
  const [root, reply] = (fixture("matrix-thread-events.json") as unknown[]).map(event);

  assert.equal(getThreadReplyRootEventId(root), null);
  assert.equal(getThreadRootForEvent(root), "$root");
  assert.equal(isThreadReply(root), false);
  assert.equal(getBundledThreadReplyCount(root), 2);

  assert.equal(getThreadReplyRootEventId(reply), "$root");
  assert.equal(getThreadRootForEvent(reply), "$root");
  assert.equal(isThreadReply(reply), true);
});

test("loads, sorts, and deduplicates thread relation events", async () => {
  const [root, replyTwo, replyOne] = (fixture("matrix-thread-events.json") as unknown[]).map(event);
  const client = {
    relations: async () => ({
      events: [replyTwo, replyOne, replyOne],
      originalEvent: root,
    }),
  } as unknown as MatrixClient;
  const room = {
    findEventById: (eventId: string) => (eventId === "$root" ? root : null),
    roomId: "!room:example.org",
  } as unknown as Room;

  const events = await loadThreadEvents(client, room, "$root");

  assert.deepEqual(events.map((item) => item.getId()), ["$root", "$reply-1", "$reply-2"]);
});

test("classifies joined rooms, spaces, and direct messages", async () => {
  const room = fakeRoom({
    lastActiveTs: 20,
    membership: "join",
    name: "General",
    roomId: "!room:example.org",
  });
  const space = fakeRoom({
    lastActiveTs: 30,
    membership: "join",
    name: "Workspace",
    roomId: "!space:example.org",
    space: true,
  });
  const client = {
    getAccountData: (type: string) =>
      type === EventType.Direct
        ? {
            getContent: () => ({
              "@bob:example.org": ["!room:example.org", "!space:example.org"],
            }),
          }
        : undefined,
    getRoom: (roomId: string) =>
      new Map([
        [room.roomId, room],
        [space.roomId, space],
      ]).get(roomId) ?? null,
    getRooms: () => [room, space],
  } as unknown as MatrixClient;

  assert.equal(isSpaceRoom(space), true);
  assert.equal(isSpaceRoom(room), false);
  assert.deepEqual(getJoinedRooms(client).map((item) => item.roomId), ["!room:example.org"]);
  assert.deepEqual((await getJoinedDirectRooms(client)).map((item) => item.roomId), [
    "!room:example.org",
  ]);
  assert.equal(getRoomDisplayName(room), "General");
});

test("detects one-to-one pending direct invites", () => {
  const invite = new MatrixEvent({
    content: { membership: "invite" },
    event_id: "$invite",
    origin_server_ts: 0,
    room_id: "!invite:example.org",
    sender: "@alice:example.org",
    state_key: "@me:example.org",
    type: EventType.RoomMember,
  });
  const room = {
    currentState: {
      getStateEvents: (type: string, stateKey: string) =>
        type === EventType.RoomMember && stateKey === "@me:example.org"
          ? invite
          : undefined,
    },
    getDMInviter: () => undefined,
    getInvitedAndJoinedMemberCount: () => 2,
    getLastActiveTimestamp: () => 0,
    getMyMembership: () => "invite",
    guessDMUserId: () => "@alice:example.org",
    myUserId: "@me:example.org",
    name: "",
    roomId: "!invite:example.org",
  } as unknown as Room;
  const client = {
    getRooms: () => [room],
  } as unknown as MatrixClient;

  assert.deepEqual(getPendingDirectRoomInvites(client), [
    {
      inviterUserId: "@alice:example.org",
      name: "@alice:example.org",
      roomId: "!invite:example.org",
    },
  ]);
});

function fakeRoom(options: {
  lastActiveTs: number;
  membership: string;
  name: string;
  roomId: string;
  space?: boolean;
}): Room {
  const createEvent = options.space
    ? new MatrixEvent({
        content: { [RoomCreateTypeField]: RoomType.Space },
        event_id: `$create-${options.roomId}`,
        origin_server_ts: 0,
        room_id: options.roomId,
        sender: "@server:example.org",
        state_key: "",
        type: EventType.RoomCreate,
      })
    : undefined;

  return {
    currentState: {
      getStateEvents: (type: string) =>
        type === EventType.RoomCreate && createEvent ? createEvent : undefined,
    },
    getLastActiveTimestamp: () => options.lastActiveTs,
    getMyMembership: () => options.membership,
    guessDMUserId: () => "@bob:example.org",
    myUserId: "@me:example.org",
    name: options.name,
    roomId: options.roomId,
  } as unknown as Room;
}
