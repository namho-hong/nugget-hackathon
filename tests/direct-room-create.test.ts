import assert from "node:assert/strict";
import test from "node:test";

import { EventType } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";

import { createDirectRoom } from "../src/matrix/create.js";

const me = "@me:example.org";
const target = "@alice:example.org";
const roomId = "!dm:example.org";

test("re-invites target when reusing an existing DM they left", async () => {
  const { client, invites } = fakeDirectClient("leave");

  const created = await createDirectRoom(client, target);

  assert.deepEqual(created, { name: target, roomId });
  assert.deepEqual(invites, [{ roomId, userId: target }]);
});

test("does not re-invite target when existing DM invite is already pending", async () => {
  const { client, invites } = fakeDirectClient("invite");

  const created = await createDirectRoom(client, target);

  assert.deepEqual(created, { name: target, roomId });
  assert.deepEqual(invites, []);
});

function fakeDirectClient(targetMembership: string): {
  client: MatrixClient;
  invites: Array<{ roomId: string; userId: string }>;
} {
  const invites: Array<{ roomId: string; userId: string }> = [];
  const room = {
    currentState: {
      getStateEvents: () => undefined,
    },
    getLastActiveTimestamp: () => 0,
    getMember: (userId: string) =>
      userId === target ? { membership: targetMembership } : null,
    getMyMembership: () => "join",
    guessDMUserId: () => target,
    myUserId: me,
    name: "",
    roomId,
  };

  return {
    client: {
      getAccountData: (type: string) =>
        type === EventType.Direct
          ? {
              getContent: () => ({
                [target]: [roomId],
              }),
            }
          : undefined,
      getRoom: (candidateRoomId: string) =>
        candidateRoomId === roomId ? room : null,
      getStateEvent: async (
        candidateRoomId: string,
        _eventType: string,
        stateKey: string,
      ) => {
        if (candidateRoomId !== roomId) {
          throw new Error("unknown room");
        }

        if (stateKey === me) {
          return { membership: "join" };
        }

        if (stateKey === target) {
          return { membership: targetMembership };
        }

        throw new Error("unknown member");
      },
      getUserId: () => me,
      invite: async (candidateRoomId: string, userId: string) => {
        invites.push({ roomId: candidateRoomId, userId });
        return {};
      },
    } as unknown as MatrixClient,
    invites,
  };
}
