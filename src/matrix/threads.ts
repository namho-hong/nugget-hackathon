import {
  EventType,
  MatrixEvent,
  MsgType,
  RelationType,
  type MatrixClient,
} from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events.js";
import type { Room } from "matrix-js-sdk";

export const THREAD_RELATION_TYPE = "m.thread";

export async function loadThreadEvents(
  client: MatrixClient,
  room: Room,
  threadRootEventId: string,
): Promise<MatrixEvent[]> {
  const result = await client.relations(
    room.roomId,
    threadRootEventId,
    THREAD_RELATION_TYPE,
    EventType.RoomMessage,
  );
  const events = dedupeEvents([
    result.originalEvent ?? room.findEventById(threadRootEventId) ?? null,
    ...result.events,
  ]);

  return events.sort((a, b) => a.getTs() - b.getTs());
}

export async function sendThreadMessage(
  client: MatrixClient,
  roomId: string,
  threadRootEventId: string,
  replyToEventId: string | null,
  body: string,
): Promise<MatrixEvent> {
  const content = {
    body,
    msgtype: MsgType.Text,
    "m.relates_to": {
      "m.in_reply_to": {
        event_id: replyToEventId ?? threadRootEventId,
      },
      event_id: threadRootEventId,
      rel_type: RelationType.Thread,
    },
  };
  const response = await client.sendMessage(roomId, content as unknown as RoomMessageEventContent);
  const eventId = response.event_id;

  return new MatrixEvent({
    content,
    event_id: eventId,
    origin_server_ts: Date.now(),
    room_id: roomId,
    sender: client.getUserId() ?? "",
    type: EventType.RoomMessage,
    unsigned: {},
  });
}

export function isThreadReply(event: MatrixEvent): boolean {
  const eventId = event.getId();
  const rootEventId = getThreadReplyRootEventId(event);

  return !!eventId && !!rootEventId && rootEventId !== eventId;
}

export function getThreadRootForEvent(event: MatrixEvent): string | null {
  return getThreadReplyRootEventId(event) ?? event.getId() ?? null;
}

export function getThreadReplyRootEventId(event: MatrixEvent): string | null {
  const contentRoot = getThreadRootFromContent(event.getContent<Record<string, unknown>>());

  if (contentRoot) {
    return contentRoot;
  }

  const sdkRoot = event.threadRootId;
  return typeof sdkRoot === "string" && sdkRoot.length > 0 ? sdkRoot : null;
}

export function getBundledThreadReplyCount(event: MatrixEvent): number {
  const unsigned = event.getUnsigned();
  const relations = unsigned["m.relations"];

  if (!isRecord(relations)) {
    return 0;
  }

  const thread = relations[THREAD_RELATION_TYPE];

  if (!isRecord(thread) || typeof thread.count !== "number") {
    return 0;
  }

  return Math.max(0, Math.floor(thread.count));
}

function getThreadRootFromContent(content: Record<string, unknown>): string | null {
  const relatesTo = content["m.relates_to"];

  if (!isRecord(relatesTo) || relatesTo.rel_type !== THREAD_RELATION_TYPE) {
    return null;
  }

  return typeof relatesTo.event_id === "string" && relatesTo.event_id.length > 0
    ? relatesTo.event_id
    : null;
}

function dedupeEvents(events: Array<MatrixEvent | null>): MatrixEvent[] {
  const seen = new Set<string>();
  const deduped: MatrixEvent[] = [];

  for (const event of events) {
    const eventId = event?.getId();

    if (!event || !eventId || seen.has(eventId)) {
      continue;
    }

    seen.add(eventId);
    deduped.push(event);
  }

  return deduped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
