import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EventType,
  MatrixEvent,
  RoomCreateTypeField,
  RoomEvent,
  RoomType,
} from "matrix-js-sdk";
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
  getPendingDirectRoomInviteTarget,
  getPendingDirectRoomInvites,
  getRoomDisplayName,
  isSpaceRoom,
  waitForJoinedRoom,
} from "../src/matrix/rooms.js";
import {
  getJoinedSpaces,
  waitForJoinedSpace,
} from "../src/matrix/spaces.js";
import {
  getInviteViaServers,
  rejectRoomInvite,
  removeDirectRoomAccountData,
} from "../src/matrix/membership.js";

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

test("excludes stale local joined spaces missing from the server joined list", async () => {
  const joinedSpace = fakeRoom({
    lastActiveTs: 30,
    membership: "join",
    name: "Joined Workspace",
    roomId: "!joined-space:example.org",
    space: true,
  });
  const leftSpace = fakeRoom({
    lastActiveTs: 40,
    membership: "join",
    name: "Left Workspace",
    roomId: "!left-space:example.org",
    space: true,
  });
  const client = {
    getJoinedRooms: async () => ({
      joined_rooms: ["!joined-space:example.org"],
    }),
    getRooms: () => [leftSpace, joinedSpace],
  } as unknown as MatrixClient;

  assert.deepEqual((await getJoinedSpaces(client)).map((item) => item.roomId), [
    "!joined-space:example.org",
  ]);
});

test("rejects opening a stale local joined space missing from the server joined list", async () => {
  const space = fakeRoom({
    lastActiveTs: 40,
    membership: "join",
    name: "Left Workspace",
    roomId: "!left-space:example.org",
    space: true,
  });
  const client = {
    getJoinedRooms: async () => ({
      joined_rooms: [],
    }),
    getRoom: (roomId: string) => (roomId === space.roomId ? space : null),
  } as unknown as MatrixClient;

  await assert.rejects(
    waitForJoinedSpace(client, space.roomId, 1_000),
    /Space !left-space:example\.org is still present in local Matrix sync as joined, but the homeserver no longer reports this session as joined\./,
  );
});

test("lists direct rooms joined on server while local sync still says invite", async () => {
  const room = fakeRoom({
    lastActiveTs: 20,
    membership: "invite",
    name: "Alice",
    roomId: "!accepted:example.org",
  });
  const client = {
    getAccountData: (type: string) =>
      type === EventType.Direct
        ? {
            getContent: () => ({
              "@alice:example.org": ["!accepted:example.org"],
            }),
          }
        : undefined,
    getRoom: (roomId: string) => (roomId === room.roomId ? room : null),
    getStateEvent: async () => ({ membership: "join" }),
    getUserId: () => "@me:example.org",
  } as unknown as MatrixClient;

  assert.deepEqual((await getJoinedDirectRooms(client)).map((item) => item.roomId), [
    "!accepted:example.org",
  ]);
});

test("hides direct rooms left on server while local sync still says joined", async () => {
  const room = fakeRoom({
    lastActiveTs: 20,
    membership: "join",
    name: "Alice",
    roomId: "!left:example.org",
  });
  const client = {
    getAccountData: (type: string) =>
      type === EventType.Direct
        ? {
            getContent: () => ({
              "@alice:example.org": ["!left:example.org"],
            }),
          }
        : undefined,
    getRoom: (roomId: string) => (roomId === room.roomId ? room : null),
    getStateEvent: async () => ({ membership: "leave" }),
    getUserId: () => "@me:example.org",
  } as unknown as MatrixClient;

  assert.deepEqual(await getJoinedDirectRooms(client), []);
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

test("resolves pending direct invite target when member counts are incomplete", () => {
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
    getInvitedAndJoinedMemberCount: () => 0,
    getLastActiveTimestamp: () => 0,
    getMyMembership: () => "invite",
    guessDMUserId: () => undefined,
    myUserId: "@me:example.org",
    name: "",
    roomId: "!invite:example.org",
  } as unknown as Room;
  const client = {
    getRoom: (roomId: string) => (roomId === room.roomId ? room : null),
  } as unknown as MatrixClient;

  assert.deepEqual(getPendingDirectRoomInviteTarget(client, room.roomId), {
    inviterUserId: "@alice:example.org",
    name: "@alice:example.org",
    roomId: "!invite:example.org",
  });
});

test("derives invite via servers from room and inviter IDs", () => {
  const invite = new MatrixEvent({
    content: { membership: "invite" },
    event_id: "$invite",
    origin_server_ts: 0,
    room_id: "!invite:room.example.org",
    sender: "@alice:sender.example.org",
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
    getDMInviter: () => "@carol:dm.example.org",
    myUserId: "@me:example.org",
    roomId: "!invite:room.example.org",
  } as unknown as Room;

  assert.deepEqual(getInviteViaServers(room, ["@bob:sender.example.org"]), [
    "room.example.org",
    "sender.example.org",
    "dm.example.org",
  ]);
});

test("removes left rooms from direct account data", async () => {
  let nextContent: Record<string, string[]> | null = null;
  const client = {
    getAccountData: (type: string) =>
      type === EventType.Direct
        ? {
            getContent: () => ({
              "@alice:example.org": ["!left:example.org", "!keep:example.org"],
              "@bob:example.org": ["!left:example.org"],
              "@carol:example.org": ["!other:example.org"],
            }),
          }
        : undefined,
    setAccountData: async (type: string, content: Record<string, string[]>) => {
      assert.equal(type, EventType.Direct);
      nextContent = content;
    },
  } as unknown as MatrixClient;

  await removeDirectRoomAccountData(client, "!left:example.org");

  assert.deepEqual(nextContent, {
    "@alice:example.org": ["!keep:example.org"],
    "@carol:example.org": ["!other:example.org"],
  });
});

test("rejects invite rooms and forgets them from the local store", async () => {
  let membership = "invite";
  const calls: string[] = [];
  const room = {
    getMyMembership: () => membership,
    roomId: "!invite:example.org",
  } as unknown as Room;
  const client = {
    forget: async (roomId: string) => {
      calls.push(`forget ${roomId}`);
    },
    getRoom: (roomId: string) => (roomId === room.roomId ? room : null),
    leave: async (roomId: string) => {
      calls.push(`leave ${roomId}`);
      membership = "leave";
    },
  } as unknown as MatrixClient;

  await rejectRoomInvite(client, room.roomId);

  assert.deepEqual(calls, [
    "leave !invite:example.org",
    "forget !invite:example.org",
  ]);
});

test("waits for stale invite membership when server already reports joined", async () => {
  let membership = "invite";
  const roomId = "!accepted:example.org";
  const room = {
    currentState: {
      getStateEvents: () => undefined,
    },
    getMyMembership: () => membership,
    roomId,
  } as unknown as Room;
  const client = Object.assign(new EventEmitter(), {
    getRoom: (candidateRoomId: string) => (candidateRoomId === roomId ? room : null),
    getStateEvent: async () => ({ membership: "join" }),
    getSyncState: () => undefined,
    getUserId: () => "@me:example.org",
  }) as unknown as MatrixClient;

  const waiting = waitForJoinedRoom(client, roomId, 1_000);

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  membership = "join";
  client.emit(RoomEvent.MyMembership, room, "join");

  assert.equal(await waiting, room);
});

test("fails stale invite membership when server does not report joined", async () => {
  const roomId = "!pending:example.org";
  const room = {
    getMyMembership: () => "invite",
    roomId,
  } as unknown as Room;
  const client = Object.assign(new EventEmitter(), {
    getRoom: (candidateRoomId: string) => (candidateRoomId === roomId ? room : null),
    getStateEvent: async () => ({ membership: "invite" }),
    getUserId: () => "@me:example.org",
  }) as unknown as MatrixClient;

  await assert.rejects(
    waitForJoinedRoom(client, roomId, 1_000),
    /Room !pending:example\.org is not joined by the current Matrix session \(membership invite\)\./,
  );
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
