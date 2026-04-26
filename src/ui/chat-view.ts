import { emitKeypressEvents } from "node:readline";

import {
  ClientEvent,
  EventType,
  MatrixEvent,
  MsgType,
  RoomEvent,
  SyncState,
  type MatrixClient,
} from "matrix-js-sdk";
import type { Room } from "matrix-js-sdk";

import { CmuxClient } from "../cmux/index.js";
import type {
  AgentContextMessage,
  AgentName,
  ChatAgentRequest,
} from "../agent/types.js";
import {
  getBundledThreadReplyCount,
  getRoomDisplayName,
  getThreadReplyRootEventId,
  getThreadRootForEvent,
  inviteToRoom,
  isThreadReply,
  leaveRoom,
  loadThreadEvents,
  resolveRoomOrThrow,
  sendThreadMessage,
} from "../matrix/index.js";
import { parseAgentMention } from "./chat-commands.js";
import { formatErrorMessage } from "../util/errors.js";

const HISTORY_BATCH_SIZE = 100;
const MAX_HISTORY_BATCHES = 1000;
const HEADER_LINES = 2;
const COMPOSER_LINES = 3;
const MESSAGE_LEFT_PADDING = 1;
const MESSAGE_GAP = 2;
const MESSAGE_TIME_WIDTH = 5;
const MESSAGE_MIN_NAME_WIDTH = 8;
const MESSAGE_MAX_NAME_WIDTH = 24;
const MESSAGE_MIN_BODY_WIDTH = 10;
const AGENT_CONTEXT_MESSAGE_LIMIT = 30;
const ANSI_RESET = "\x1b[0m";
const INVERSE = "\x1b[7m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const FOREGROUND_RESET = "\x1b[39m";
const SENDER_COLORS = [
  "\x1b[38;5;39m",
  "\x1b[38;5;83m",
  "\x1b[38;5;214m",
  "\x1b[38;5;207m",
  "\x1b[38;5;45m",
  "\x1b[38;5;220m",
  "\x1b[38;5;141m",
  "\x1b[38;5;160m",
  "\x1b[38;5;51m",
  "\x1b[38;5;118m",
  "\x1b[38;5;202m",
  "\x1b[38;5;213m",
  "\x1b[38;5;33m",
  "\x1b[38;5;190m",
  "\x1b[38;5;177m",
  "\x1b[38;5;196m",
];

export interface OpenChatViewOptions {
  historyBatchSize?: number;
  maxHistoryBatches?: number;
  onAgentRequest?: (request: ChatAgentRequest) => Promise<void> | void;
  onLeaveRoom?: (roomId: string) => Promise<void> | void;
  onOpenThread?: (threadRootEventId: string) => Promise<void> | void;
}

export interface OpenThreadViewOptions {
  onAgentRequest?: (request: ChatAgentRequest) => Promise<void> | void;
  onOpenThread?: (threadRootEventId: string) => Promise<void> | void;
}

export type ChatViewResult = { type: "home" } | { type: "quit" };

interface RenderedMessage {
  type: "message";
  eventId: string;
  senderId: string;
  senderLabel: string;
  body: string;
  replyCount: number;
  timestamp: number;
}

interface RenderedNotice {
  type: "notice";
  eventId: string;
  text: string;
  timestamp: number;
}

type HistoryEntry = RenderedMessage | RenderedNotice;

type ChatViewMode =
  | {
      type: "room";
      onAgentRequest?: (request: ChatAgentRequest) => Promise<void> | void;
      onLeaveRoom?: (roomId: string) => Promise<void> | void;
      onOpenThread?: (threadRootEventId: string) => Promise<void> | void;
    }
  | {
      type: "thread";
      initialNotice?: string;
      initialThreadEvents: MatrixEvent[];
      onAgentRequest?: (request: ChatAgentRequest) => Promise<void> | void;
      onOpenThread?: (threadRootEventId: string) => Promise<void> | void;
      threadRootEventId: string;
    };

export async function openChatView(
  client: MatrixClient,
  roomId: string,
  options: OpenChatViewOptions = {},
): Promise<ChatViewResult> {
  const room = resolveRoomOrThrow(client, roomId);

  process.stdout.write(`Loading history for ${getRoomDisplayName(room)}...\n`);
  await loadFullHistory(client, room, options);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(renderTranscript(room, process.stdout.columns ?? 80));
    return { type: "quit" };
  }

  return await runInteractiveChat(client, room, {
    ...(options.onAgentRequest ? { onAgentRequest: options.onAgentRequest } : {}),
    ...(options.onLeaveRoom ? { onLeaveRoom: options.onLeaveRoom } : {}),
    type: "room",
    ...(options.onOpenThread ? { onOpenThread: options.onOpenThread } : {}),
  });
}

export async function openThreadView(
  client: MatrixClient,
  roomId: string,
  threadRootEventId: string,
  options: OpenThreadViewOptions = {},
): Promise<ChatViewResult> {
  const room = resolveRoomOrThrow(client, roomId);
  let threadEvents: MatrixEvent[] = [];
  let initialNotice: string | undefined;

  process.stdout.write(`Loading thread ${threadRootEventId} in ${getRoomDisplayName(room)}...\n`);

  try {
    threadEvents = await loadThreadEvents(client, room, threadRootEventId);
  } catch (error) {
    const rootEvent = room.findEventById(threadRootEventId);
    threadEvents = rootEvent ? [rootEvent] : [];
    initialNotice = `Thread relation loading failed: ${formatError(error)}`;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(
      renderTranscriptFromEvents(room, threadEvents, process.stdout.columns ?? 80, {
        threadRootEventId,
        notice: initialNotice ?? "",
      }),
    );
    return { type: "quit" };
  }

  return await runInteractiveChat(client, room, {
    initialThreadEvents: threadEvents,
    ...(initialNotice ? { initialNotice } : {}),
    ...(options.onAgentRequest ? { onAgentRequest: options.onAgentRequest } : {}),
    ...(options.onOpenThread ? { onOpenThread: options.onOpenThread } : {}),
    threadRootEventId,
    type: "thread",
  });
}

export async function loadFullHistory(
  client: MatrixClient,
  room: Room,
  options: OpenChatViewOptions = {},
): Promise<void> {
  const batchSize = options.historyBatchSize ?? HISTORY_BATCH_SIZE;
  const maxBatches = options.maxHistoryBatches ?? MAX_HISTORY_BATCHES;
  const timeline = room.getLiveTimeline();
  let previousEventCount = timeline.getEvents().length;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    let hasMore = false;

    try {
      hasMore = await client.paginateEventTimeline(timeline, {
        backwards: true,
        limit: batchSize,
      });
    } catch (error) {
      process.stdout.write(`History pagination stopped: ${formatError(error)}\n`);
      return;
    }

    const eventCount = timeline.getEvents().length;

    if (eventCount !== previousEventCount && (batch === 0 || (batch + 1) % 10 === 0)) {
      process.stdout.write(`Loaded ${eventCount} timeline events...\n`);
    }

    previousEventCount = eventCount;

    if (!hasMore) {
      return;
    }
  }

  process.stdout.write(`Stopped history loading after ${maxBatches} batches.\n`);
}

async function runInteractiveChat(
  client: MatrixClient,
  room: Room,
  mode: ChatViewMode,
): Promise<ChatViewResult> {
  const threadEvents = mode.type === "thread" ? [...mode.initialThreadEvents] : [];
  const cmux = new CmuxClient();
  const localUserId = client.getUserId() ?? room.myUserId;
  const seenEventIds = new Set(
    (mode.type === "thread" ? threadEvents : room.getLiveTimeline().getEvents())
      .map((event) => event.getId())
      .filter((eventId): eventId is string => typeof eventId === "string"),
  );

  let inputBuffer = "";
  const pendingMessages: string[] = [];
  let notice = mode.type === "thread" ? "Thread view. Type /help for commands." : "Type /help for commands.";
  let submitting = false;
  let scrollOffsetFromBottom = 0;
  let selectionMode = false;
  let selectedEventId: string | null = null;
  let syncNoticeActive = false;
  let closed = false;
  let newMessagesBelow = 0;
  let lastHistoryLineCount = 0;

  if (mode.type === "thread" && mode.initialNotice) {
    notice = mode.initialNotice;
  }

  emitKeypressEvents(process.stdin);
  process.stdin.resume();
  process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?25l\x1b[?1000l\x1b[?1006l");

  return await new Promise<ChatViewResult>((resolve) => {
    const finish = (result: ChatViewResult, message?: string): void => {
      if (closed) {
        return;
      }

      closed = true;
      cleanup();
      process.stdout.write("\x1b[2J\x1b[H");
      if (message) {
        process.stdout.write(`${message}\n`);
      }
      resolve(result);
    };

    const render = (): void => {
      if (closed) {
        return;
      }

      const height = Math.max(10, process.stdout.rows ?? 24);
      const width = Math.max(30, process.stdout.columns ?? 80);
      const entries = getCurrentEntries();
      const historyLines = renderHistory(entries, width, selectionMode ? selectedEventId : null);
      const slashLines = renderSlashHelp(inputBuffer, width, mode);
      let markerLines = renderNewMessagesMarker(newMessagesBelow, width);
      let visibleHistoryHeight = Math.max(
        1,
        height - HEADER_LINES - markerLines.length - slashLines.length - COMPOSER_LINES,
      );
      let maxScroll = Math.max(0, historyLines.length - visibleHistoryHeight);
      scrollOffsetFromBottom = Math.min(scrollOffsetFromBottom, maxScroll);

      if (scrollOffsetFromBottom === 0 && newMessagesBelow > 0) {
        newMessagesBelow = 0;
        markerLines = [];
        visibleHistoryHeight = Math.max(
          1,
          height - HEADER_LINES - slashLines.length - COMPOSER_LINES,
        );
        maxScroll = Math.max(0, historyLines.length - visibleHistoryHeight);
        scrollOffsetFromBottom = Math.min(scrollOffsetFromBottom, maxScroll);
      }

      const end = historyLines.length - scrollOffsetFromBottom;
      const start = Math.max(0, end - visibleHistoryHeight);
      const visibleHistory = historyLines.slice(start, end);
      const paddedHistory = padLines(visibleHistory, visibleHistoryHeight, width);
      const header = renderHeader(
        room,
        notice,
        width,
        mode.type === "thread" ? mode.threadRootEventId : undefined,
      );
      const visibleInput = sliceDisplayTextFromEnd(inputBuffer, Math.max(1, width - 3));
      const composer = renderComposer(visibleInput, submitting, pendingMessages.length, width, selectionMode);
      const frame = [...header, ...paddedHistory, ...markerLines, ...slashLines, ...composer];
      const cursorRow =
        header.length + paddedHistory.length + markerLines.length + slashLines.length + 2;
      const cursorColumn = Math.min(getDisplayWidth(`> ${visibleInput}`) + 1, width);

      lastHistoryLineCount = historyLines.length;
      process.stdout.write("\x1b[?25l\x1b[0m\x1b[H\x1b[2J");
      process.stdout.write(frame.join("\n"));
      process.stdout.write(`\x1b[${cursorRow};${cursorColumn}H\x1b[?25h`);
    };

    const cleanup = (): void => {
      room.off(RoomEvent.Timeline, onTimeline);
      client.off(ClientEvent.Sync, onSync);
      process.stdout.off("resize", render);
      process.stdin.off("keypress", onKeypress);

      if (process.stdin.isRaw) {
        process.stdin.setRawMode(false);
      }

      process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[0m\n");
    };

    const setNotice = (message: string, isSyncNotice = false): void => {
      notice = message;
      syncNoticeActive = isSyncNotice;
      render();
    };

    const submitText = async (rawText: string): Promise<void> => {
      const text = rawText.trim();

      if (text.length === 0) {
        return;
      }

      if (submitting) {
        if (!text.startsWith("/") && parseAgentMention(text).type !== "agent") {
          inputBuffer = "";
          pendingMessages.push(text);
          render();
          return;
        }

        setNotice("Wait for the current operation before submitting commands.");
        return;
      }

      if (text === "/quit" || text === "/exit") {
        inputBuffer = "";
        finish({ type: "quit" });
        return;
      }

      if (text === "/home") {
        inputBuffer = "";
        finish({ type: "home" });
        return;
      }

      if (text === "/help") {
        inputBuffer = "";
        setNotice(`Commands: ${slashCommands(mode).join(", ")}`);
        return;
      }

      if (text === "/leave") {
        if (mode.type !== "room") {
          inputBuffer = "";
          setNotice("Leave is unavailable in this thread view.");
          return;
        }

        inputBuffer = "";
        submitting = true;
        render();

        try {
          await leaveRoom(client, room.roomId);
          await mode.onLeaveRoom?.(room.roomId);
          finish({ type: "quit" }, `Left room ${room.roomId}.`);
        } catch (error) {
          submitting = false;
          setNotice(`Leave failed for ${room.roomId}: ${formatError(error)}`);
          void flushPendingMessages();
        }

        return;
      }

      if (text === "/select") {
        if (!canOpenThreads(mode)) {
          inputBuffer = "";
          setNotice("Selection is unavailable in this thread view.");
          return;
        }

        const messages = getSelectableMessages(getCurrentEntries());

        inputBuffer = "";

        if (messages.length === 0) {
          setNotice("No selectable messages in the current timeline.");
          return;
        }

        selectionMode = true;
        selectedEventId = messages.at(-1)?.eventId ?? null;
        setNotice("Select message: Up/Down moves, Enter opens thread, Esc cancels.");
        return;
      }

      if (text === "/invite" || text.startsWith("/invite ")) {
        const userId = text.slice("/invite".length).trim();

        if (userId.length === 0) {
          inputBuffer = "";
          setNotice("Usage: /invite @user:server");
          return;
        }

        inputBuffer = "";
        submitting = true;
        render();

        try {
          await inviteToRoom(client, room.roomId, userId);
          setNotice(`Invited ${userId}.`);
        } catch (error) {
          setNotice(`Invite failed for ${userId} in ${room.roomId}: ${formatError(error)}`);
        } finally {
          submitting = false;
          render();
          void flushPendingMessages();
        }

        return;
      }

      const agentMention = parseAgentMention(text);

      if (agentMention.type === "agent") {
        if (agentMention.emptyPrompt) {
          inputBuffer = "";
          setNotice(`Usage: @${agentMention.agent} <request>`);
          return;
        }

        inputBuffer = "";
        submitting = true;
        render();

        let messageSent = false;

        try {
          const triggerEventId =
            mode.type === "thread"
              ? await sendThreadAgentTrigger(text)
              : await sendRoomAgentTrigger(text);
          messageSent = true;

          if (!mode.onAgentRequest) {
            setNotice("Message sent. Agent panes are only available inside a cmux workspace.");
            return;
          }

          await mode.onAgentRequest(
            buildChatAgentRequest(
              room,
              mode,
              threadEvents,
              agentMention.agent,
              agentMention.prompt,
              triggerEventId,
              text,
              localUserId,
              selectionMode ? selectedEventId : null,
            ),
          );
          setNotice(`Started ${agentMention.agent}.`);
        } catch (error) {
          setNotice(
            messageSent
              ? `Agent start failed after sending message: ${formatError(error)}`
              : `Send failed in ${room.roomId}: ${formatError(error)}`,
          );
        } finally {
          submitting = false;
          render();
          void flushPendingMessages();
        }

        return;
      }

      if (text.startsWith("/")) {
        inputBuffer = "";
        setNotice(`Unknown command: ${text.split(/\s+/, 1)[0] ?? text}`);
        return;
      }

      inputBuffer = "";
      pendingMessages.push(text);
      void flushPendingMessages();
    };

    const flushPendingMessages = async (): Promise<void> => {
      if (submitting || pendingMessages.length === 0) {
        return;
      }

      submitting = true;
      render();

      let activeMessage: string | null = null;

      try {
        while (pendingMessages.length > 0 && !closed) {
          activeMessage = pendingMessages.shift() ?? null;

          if (!activeMessage) {
            continue;
          }

          if (mode.type === "thread") {
            const sentEvent = await sendThreadMessage(
              client,
              room.roomId,
              mode.threadRootEventId,
              getLatestThreadReplyTarget(threadEvents, mode.threadRootEventId),
              activeMessage,
            );

            appendThreadEvent(threadEvents, seenEventIds, sentEvent);
          } else {
            await client.sendMessage(room.roomId, {
              body: activeMessage,
              msgtype: MsgType.Text,
            });
          }

          activeMessage = null;

          if (!syncNoticeActive) {
            setNotice(pendingMessages.length > 0 ? `Sent. ${pendingMessages.length} queued.` : "Sent.");
          }
        }
      } catch (error) {
        const unsentCount = (activeMessage ? 1 : 0) + pendingMessages.length;
        pendingMessages.length = 0;
        setNotice(
          `Send failed in ${room.roomId}: ${formatError(error)}${
            unsentCount > 1 ? ` ${unsentCount} messages were not sent.` : ""
          }`,
        );
      } finally {
        submitting = false;
        render();
      }
    };

    const sendRoomAgentTrigger = async (text: string): Promise<string> => {
      const response = await client.sendMessage(room.roomId, {
        body: text,
        msgtype: MsgType.Text,
      });

      return getSentEventId(response);
    };

    const sendThreadAgentTrigger = async (text: string): Promise<string> => {
      const sentEvent = await sendThreadMessage(
        client,
        room.roomId,
        mode.type === "thread" ? mode.threadRootEventId : "",
        mode.type === "thread"
          ? getLatestThreadReplyTarget(threadEvents, mode.threadRootEventId)
          : "",
        text,
      );

      appendThreadEvent(threadEvents, seenEventIds, sentEvent);

      const eventId = sentEvent.getId();

      if (!eventId) {
        throw new Error("Matrix send response did not include an event ID.");
      }

      return eventId;
    };

    const openSelectedThread = async (): Promise<void> => {
      const selectedId = selectedEventId;

      if (!selectedId || submitting) {
        return;
      }

      const selectedEvent = findEventForSelection(room, threadEvents, selectedId);
      const threadRootEventId = selectedEvent ? getThreadRootForEvent(selectedEvent) : selectedId;

      if (!threadRootEventId) {
        selectionMode = false;
        selectedEventId = null;
        setNotice("Selected message has no event ID.");
        return;
      }

      if (mode.type === "thread" && threadRootEventId === mode.threadRootEventId && !mode.onOpenThread) {
        selectionMode = false;
        selectedEventId = null;
        setNotice("Already viewing this thread.");
        return;
      }

      if (!mode.onOpenThread) {
        selectionMode = false;
        selectedEventId = null;
        setNotice("Thread opening is unavailable in this view.");
        return;
      }

      submitting = true;
      render();

      try {
        await mode.onOpenThread(threadRootEventId);
        selectionMode = false;
        selectedEventId = null;
        setNotice(`Opened thread ${threadRootEventId}.`);
      } catch (error) {
        setNotice(
          `Could not open thread ${threadRootEventId} from room ${room.roomId}: ${formatError(error)}`,
        );
      } finally {
        submitting = false;
        render();
        void flushPendingMessages();
      }
    };

    const onTimeline = (
      event: MatrixEvent,
      eventRoom: Room | undefined,
      toStartOfTimeline: boolean | undefined,
      removed: boolean | undefined,
    ): void => {
      if (removed || toStartOfTimeline || eventRoom?.roomId !== room.roomId) {
        return;
      }

      const eventId = event.getId();

      if (eventId) {
        if (seenEventIds.has(eventId)) {
          return;
        }

        seenEventIds.add(eventId);
      }

      const wasAtBottom = scrollOffsetFromBottom === 0;
      const beforeLineCount = lastHistoryLineCount;
      let visibleIncoming = mode.type === "room" && !isThreadReply(event);

      if (mode.type === "thread") {
        if (!shouldShowInThread(event, mode.threadRootEventId)) {
          return;
        }

        visibleIncoming = true;
        threadEvents.push(event);
        threadEvents.sort((a, b) => a.getTs() - b.getTs());
      }

      if (visibleIncoming && isIncomingMessageEvent(event)) {
        if (wasAtBottom) {
          scrollOffsetFromBottom = 0;
        } else {
          const width = Math.max(30, process.stdout.columns ?? 80);
          const afterLineCount = renderHistory(
            getCurrentEntries(),
            width,
            selectionMode ? selectedEventId : null,
          ).length;
          scrollOffsetFromBottom += Math.max(1, afterLineCount - beforeLineCount);
          newMessagesBelow += 1;
        }

        if (!isLocalEvent(event, localUserId)) {
          const notification = formatIncomingNotification(room, event);

          if (notification) {
            void cmux.notify(notification);
          }
        }
      }

      render();
    };

    const onSync = (state: SyncState, previousState: SyncState | null): void => {
      if (state === SyncState.Reconnecting) {
        setNotice("Connection lost. Reconnecting...", true);
        return;
      }

      if (state === SyncState.Error) {
        setNotice("Sync paused. Retrying...", true);
        return;
      }

      if (
        syncNoticeActive &&
        (state === SyncState.Prepared ||
          state === SyncState.Syncing ||
          state === SyncState.Catchup) &&
        (previousState === SyncState.Reconnecting || previousState === SyncState.Error)
      ) {
        setNotice("Reconnected.");
      }
    };

    const onKeypress = (text: string, key: KeypressEvent): void => {
      if (key.ctrl && key.name === "c") {
        finish({ type: "quit" });
        return;
      }

      if (selectionMode) {
        if (key.name === "escape") {
          selectionMode = false;
          selectedEventId = null;
          setNotice("Selection cancelled.");
          return;
        }

        if (key.name === "up") {
          selectedEventId = moveSelection(getSelectableMessages(getCurrentEntries()), selectedEventId, -1);
          render();
          return;
        }

        if (key.name === "down") {
          selectedEventId = moveSelection(getSelectableMessages(getCurrentEntries()), selectedEventId, 1);
          render();
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          void openSelectedThread();
          return;
        }

        return;
      }

      if (key.name === "return" || key.name === "enter") {
        void submitText(inputBuffer);
        return;
      }

      if (key.name === "backspace") {
        inputBuffer = Array.from(inputBuffer).slice(0, -1).join("");
        render();
        return;
      }

      if (key.ctrl && key.name === "u") {
        inputBuffer = "";
        render();
        return;
      }

      if (key.name === "pageup") {
        scrollOffsetFromBottom += getVisibleHistoryHeight();
        render();
        return;
      }

      if (key.name === "pagedown") {
        scrollOffsetFromBottom = Math.max(0, scrollOffsetFromBottom - getVisibleHistoryHeight());
        render();
        return;
      }

      if (key.name === "up") {
        scrollOffsetFromBottom += 3;
        render();
        return;
      }

      if (key.name === "down") {
        scrollOffsetFromBottom = Math.max(0, scrollOffsetFromBottom - 3);
        render();
        return;
      }

      if (key.name === "home") {
        scrollOffsetFromBottom = Number.MAX_SAFE_INTEGER;
        render();
        return;
      }

      if (key.name === "end") {
        scrollOffsetFromBottom = 0;
        newMessagesBelow = 0;
        render();
        return;
      }

      if (!key.ctrl && text && !isControlText(text)) {
        const inputText = normalizeInputText(stripMouseInputText(text));

        if (inputText.length > 0) {
          inputBuffer += inputText;
          render();
        }
      }
    };

    const getVisibleHistoryHeight = (): number => {
      const height = Math.max(10, process.stdout.rows ?? 24);
      const slashLineCount = renderSlashHelp(inputBuffer, process.stdout.columns ?? 80, mode).length;
      const markerLineCount = newMessagesBelow > 0 ? 1 : 0;
      return Math.max(
        1,
        height - HEADER_LINES - markerLineCount - slashLineCount - COMPOSER_LINES,
      );
    };

    const getCurrentEntries = (): HistoryEntry[] => {
      return mode.type === "thread"
        ? getHistoryEntriesFromEvents(room, threadEvents, {
            includeThreadReplies: true,
            threadRootEventId: mode.threadRootEventId,
          })
        : getHistoryEntries(room);
    };

    room.on(RoomEvent.Timeline, onTimeline);
    client.on(ClientEvent.Sync, onSync);
    process.stdout.on("resize", render);
    process.stdin.on("keypress", onKeypress);
    render();
  });
}

function renderTranscript(room: Room, width: number): string {
  const header = renderHeader(room, "", width);
  const history = renderHistory(getHistoryEntries(room), width);
  return `${[...header, ...history].join("\n")}\n`;
}

function renderTranscriptFromEvents(
  room: Room,
  events: readonly MatrixEvent[],
  width: number,
  options: { notice: string; threadRootEventId: string },
): string {
  const header = renderHeader(room, options.notice, width, options.threadRootEventId);
  const history = renderHistory(
    getHistoryEntriesFromEvents(room, events, {
      includeThreadReplies: true,
      threadRootEventId: options.threadRootEventId,
    }),
    width,
  );

  return `${[...header, ...history].join("\n")}\n`;
}

function renderHeader(
  room: Room,
  notice: string,
  width: number,
  threadRootEventId?: string,
): string[] {
  const roomName = sanitizeForTerminal(getRoomDisplayName(room));
  const title = threadRootEventId ? `# ${roomName} thread` : `# ${roomName}`;

  return [
    fitDisplayText(title, width),
    fitDisplayText(notice ? `${DIM}${sanitizeForTerminal(notice)}${ANSI_RESET}` : "", width),
  ];
}

function renderHistory(
  entries: readonly HistoryEntry[],
  width: number,
  selectedEventId: string | null = null,
): string[] {
  const lines: string[] = [];
  let previousMessage: RenderedMessage | null = null;
  const senderColorIndexes = new Map<string, number>();

  for (const entry of entries) {
    if (entry.type === "notice") {
      previousMessage = null;
      lines.push(centerText(`- ${entry.text} -`, width));
      continue;
    }

    const grouped =
      previousMessage !== null &&
      previousMessage.senderId === entry.senderId &&
      minuteBucket(previousMessage.timestamp) === minuteBucket(entry.timestamp);
    const senderColorIndex = getSenderColorIndex(senderColorIndexes, entry.senderId);

    lines.push(
      ...renderMessage(entry, width, grouped, entry.eventId === selectedEventId, senderColorIndex),
    );
    previousMessage = entry;
  }

  return lines.length > 0 ? lines : [centerText("No messages yet.", width)];
}

function renderMessage(
  message: RenderedMessage,
  width: number,
  grouped: boolean,
  selected: boolean,
  senderColorIndex: number,
): string[] {
  const contentWidth = Math.max(20, width - MESSAGE_LEFT_PADDING);
  const senderWidth = Math.max(
    MESSAGE_MIN_NAME_WIDTH,
    Math.min(MESSAGE_MAX_NAME_WIDTH, Math.floor(contentWidth * 0.22)),
  );
  const bodyWidth = Math.max(
    MESSAGE_MIN_BODY_WIDTH,
    contentWidth - senderWidth - MESSAGE_TIME_WIDTH - MESSAGE_GAP * 2,
  );
  const sender = grouped ? "" : fitDisplayText(message.senderLabel, senderWidth);
  const time = grouped ? "" : formatTime(message.timestamp);
  const wrappedBody = wrapDisplayText(message.body, bodyWidth);
  const rows = wrappedBody.length > 0 ? wrappedBody : [""];

  return rows.map((body, index) => {
    const showMeta = index === 0;
    const rowSender = showMeta ? sender : "";
    const rowTime = showMeta ? time : "";
    const senderCell =
      rowSender.length > 0
        ? formatSenderCell(rowSender, senderColorIndex)
        : padDisplayText(rowSender, senderWidth);
    const line =
      " ".repeat(MESSAGE_LEFT_PADDING) +
      senderCell +
      " ".repeat(MESSAGE_GAP) +
      padDisplayText(body, bodyWidth) +
      " ".repeat(MESSAGE_GAP) +
      padDisplayText(rowTime, MESSAGE_TIME_WIDTH);

    return selected ? `${INVERSE}${line}${ANSI_RESET}` : line;
  });
}

function getSenderColorIndex(senderColorIndexes: Map<string, number>, senderId: string): number {
  const existing = senderColorIndexes.get(senderId);

  if (existing !== undefined) {
    return existing;
  }

  const next = senderColorIndexes.size % SENDER_COLORS.length;
  senderColorIndexes.set(senderId, next);
  return next;
}

function formatSenderCell(sender: string, senderColorIndex: number): string {
  if (!process.stdout.isTTY) {
    return sender;
  }

  const color = SENDER_COLORS[senderColorIndex] ?? "\x1b[38;5;39m";
  return `${BOLD}${color}${sender}${FOREGROUND_RESET}${BOLD_OFF}`;
}

function renderSlashHelp(inputBuffer: string, width: number, mode: ChatViewMode): string[] {
  if (!inputBuffer.startsWith("/")) {
    return [];
  }

  return [
    fitDisplayText(`${DIM}${slashCommands(mode).join("  ")}${ANSI_RESET}`, width),
  ];
}

function renderNewMessagesMarker(count: number, width: number): string[] {
  if (count <= 0) {
    return [];
  }

  const label = count === 1 ? "New messages below" : `${count} new messages below`;
  return [centerText(label, width)];
}

function slashCommands(mode: ChatViewMode): string[] {
  return [
    "/help",
    ...(canOpenThreads(mode) ? ["/select"] : []),
    "/invite @user:server",
    ...(mode.type === "room" ? ["/leave"] : []),
    "/home",
    "/quit",
    "/exit",
  ];
}

function canOpenThreads(mode: ChatViewMode): boolean {
  return mode.type === "room" && !!mode.onOpenThread;
}

function renderComposer(
  input: string,
  submitting: boolean,
  pendingMessageCount: number,
  width: number,
  selectionMode: boolean,
): string[] {
  const prompt = selectionMode
    ? "> selecting..."
    : input.length > 0
      ? `> ${input}`
      : submitting
        ? pendingMessageCount > 0
          ? `> sending... ${pendingMessageCount} queued`
          : "> sending..."
        : "> ";

  return [
    "",
    `${INVERSE}${fitDisplayText(prompt, width)}${ANSI_RESET}`,
    "",
  ];
}

function getHistoryEntries(room: Room): HistoryEntry[] {
  return getHistoryEntriesFromEvents(room, room.getLiveTimeline().getEvents(), {
    includeThreadReplies: false,
  });
}

function getHistoryEntriesFromEvents(
  room: Room,
  events: readonly MatrixEvent[],
  options: {
    includeThreadReplies: boolean;
    threadRootEventId?: string;
  },
): HistoryEntry[] {
  const seen = new Set<string>();
  const entries: HistoryEntry[] = [];
  const replyCounts = getThreadReplyCounts(events);

  for (const event of events) {
    const eventId = event.getId();

    if (!eventId || seen.has(eventId)) {
      continue;
    }

    seen.add(eventId);

    if (!options.includeThreadReplies && isThreadReply(event)) {
      continue;
    }

    if (options.threadRootEventId && !shouldShowInThread(event, options.threadRootEventId)) {
      continue;
    }

    const entry = buildHistoryEntry(room, event, eventId, replyCounts.get(eventId) ?? 0);

    if (entry) {
      entries.push(entry);
    }
  }

  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

function buildHistoryEntry(
  room: Room,
  event: MatrixEvent,
  eventId: string,
  replyCount: number,
): HistoryEntry | null {
  if (event.getType() === EventType.RoomMessage) {
    const content = event.getContent<Record<string, unknown>>();
    const body = typeof content.body === "string" ? sanitizeForTerminal(content.body) : "";

    if (body.trim().length === 0) {
      return null;
    }

    const senderId = event.getSender() ?? "";

    return {
      type: "message",
      body: replyCount > 0 ? `${body} [${replyCount}]` : body,
      eventId,
      replyCount,
      senderId,
      senderLabel: getSenderLabel(room, senderId),
      timestamp: event.getTs(),
    };
  }

  if (event.isState()) {
    const notice = buildNoticeEntry(event);

    if (notice) {
      return {
        type: "notice",
        eventId,
        text: notice,
        timestamp: event.getTs(),
      };
    }
  }

  return null;
}

function isIncomingMessageEvent(event: MatrixEvent): boolean {
  return getMessageBody(event) !== null;
}

function isLocalEvent(event: MatrixEvent, localUserId: string | null | undefined): boolean {
  return !!localUserId && event.getSender() === localUserId;
}

function formatIncomingNotification(
  room: Room,
  event: MatrixEvent,
): { title: string; body: string } | null {
  const body = getMessageBody(event);

  if (!body) {
    return null;
  }

  const sender = getSenderLabel(room, event.getSender() ?? "");

  return {
    title: sender,
    body,
  };
}

function getMessageBody(event: MatrixEvent): string | null {
  if (event.getType() !== EventType.RoomMessage) {
    return null;
  }

  const content = event.getContent<Record<string, unknown>>();
  const body = typeof content.body === "string" ? sanitizeForTerminal(content.body) : "";

  return body.trim().length > 0 ? body : null;
}

function getSentEventId(response: { event_id?: string }): string {
  if (typeof response.event_id === "string" && response.event_id.length > 0) {
    return response.event_id;
  }

  throw new Error("Matrix send response did not include an event ID.");
}

function buildChatAgentRequest(
  room: Room,
  mode: ChatViewMode,
  threadEvents: readonly MatrixEvent[],
  agent: AgentName,
  prompt: string,
  triggerEventId: string,
  triggerBody: string,
  localUserId: string | null | undefined,
  selectedEventId: string | null,
): ChatAgentRequest {
  const recentMessages = getRecentAgentContextMessages(room, mode, threadEvents);
  const triggerAlreadyIncluded = recentMessages.some((message) => message.eventId === triggerEventId);

  if (!triggerAlreadyIncluded) {
    const senderId = localUserId ?? room.myUserId ?? "";
    recentMessages.push({
      body: sanitizeForTerminal(triggerBody),
      eventId: triggerEventId,
      senderId,
      senderLabel: senderId.length > 0 ? getSenderLabel(room, senderId) : "You",
      ...(mode.type === "thread" ? { threadRootEventId: mode.threadRootEventId } : {}),
      timestamp: Date.now(),
    });
  }

  const cappedMessages = recentMessages.slice(-AGENT_CONTEXT_MESSAGE_LIMIT);
  const latestEventId = cappedMessages.at(-1)?.eventId;

  return {
    agent,
    isThreadView: mode.type === "thread",
    ...(latestEventId ? { latestEventId } : {}),
    prompt,
    recentMessages: cappedMessages,
    roomId: room.roomId,
    roomName: getRoomDisplayName(room),
    ...(selectedEventId ? { selectedEventId } : {}),
    ...(mode.type === "thread" ? { threadRootEventId: mode.threadRootEventId } : {}),
    triggerEventId,
  };
}

function getRecentAgentContextMessages(
  room: Room,
  mode: ChatViewMode,
  threadEvents: readonly MatrixEvent[],
): AgentContextMessage[] {
  const events = mode.type === "thread" ? threadEvents : room.getLiveTimeline().getEvents();
  const messages: AgentContextMessage[] = [];

  for (const event of events) {
    if (mode.type === "thread" && !shouldShowInThread(event, mode.threadRootEventId)) {
      continue;
    }

    const eventId = event.getId();
    const body = getMessageBody(event);

    if (!eventId || !body) {
      continue;
    }

    const senderId = event.getSender() ?? "";
    const threadRootEventId = getThreadRootForEvent(event);

    messages.push({
      body,
      eventId,
      senderId,
      senderLabel: getSenderLabel(room, senderId),
      ...(threadRootEventId && threadRootEventId !== eventId ? { threadRootEventId } : {}),
      timestamp: event.getTs(),
    });
  }

  return messages.slice(-AGENT_CONTEXT_MESSAGE_LIMIT);
}

function getThreadReplyCounts(events: readonly MatrixEvent[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const event of events) {
    const eventId = event.getId();
    const replyRootId = getThreadReplyRootEventId(event);

    if (eventId && replyRootId && replyRootId !== eventId) {
      counts.set(replyRootId, (counts.get(replyRootId) ?? 0) + 1);
    }

    if (eventId) {
      const bundledCount = getBundledThreadReplyCount(event);

      if (bundledCount > 0) {
        counts.set(eventId, Math.max(counts.get(eventId) ?? 0, bundledCount));
      }
    }
  }

  return counts;
}

function getSelectableMessages(entries: readonly HistoryEntry[]): RenderedMessage[] {
  return entries.filter((entry): entry is RenderedMessage => entry.type === "message");
}

function moveSelection(
  messages: readonly RenderedMessage[],
  selectedEventId: string | null,
  delta: -1 | 1,
): string | null {
  if (messages.length === 0) {
    return null;
  }

  const currentIndex = messages.findIndex((message) => message.eventId === selectedEventId);
  const baseIndex = currentIndex >= 0 ? currentIndex : messages.length - 1;
  const nextIndex = Math.max(0, Math.min(messages.length - 1, baseIndex + delta));

  return messages[nextIndex]?.eventId ?? null;
}

function findEventForSelection(
  room: Room,
  threadEvents: readonly MatrixEvent[],
  eventId: string,
): MatrixEvent | null {
  return (
    threadEvents.find((event) => event.getId() === eventId) ??
    room.findEventById(eventId) ??
    null
  );
}

function shouldShowInThread(event: MatrixEvent, threadRootEventId: string): boolean {
  const eventId = event.getId();

  return (
    eventId === threadRootEventId ||
    getThreadReplyRootEventId(event) === threadRootEventId
  );
}

function appendThreadEvent(
  threadEvents: MatrixEvent[],
  seenEventIds: Set<string>,
  event: MatrixEvent,
): void {
  const eventId = event.getId();

  if (!eventId || seenEventIds.has(eventId)) {
    return;
  }

  seenEventIds.add(eventId);
  threadEvents.push(event);
  threadEvents.sort((a, b) => a.getTs() - b.getTs());
}

function getLatestThreadReplyTarget(
  threadEvents: readonly MatrixEvent[],
  threadRootEventId: string,
): string {
  const latestReply = [...threadEvents]
    .filter((event) => getThreadReplyRootEventId(event) === threadRootEventId)
    .sort((a, b) => b.getTs() - a.getTs())[0];

  return latestReply?.getId() ?? threadRootEventId;
}

function buildNoticeEntry(event: MatrixEvent): string | null {
  const sender = sanitizeForTerminal(event.getSender() ?? "Someone");
  const content = event.getContent<Record<string, unknown>>();

  if (event.getType() === EventType.RoomCreate) {
    return "Room created";
  }

  if (event.getType() === EventType.RoomMember) {
    const target = sanitizeForTerminal(event.getStateKey() ?? sender);
    const membership = typeof content.membership === "string" ? content.membership : "updated";

    if (membership === "join") {
      return `${target} joined`;
    }

    if (membership === "invite") {
      return `${target} was invited`;
    }

    if (membership === "leave") {
      return `${target} left`;
    }

    if (membership === "ban") {
      return `${target} was banned`;
    }

    return `${target} membership ${membership}`;
  }

  if (event.getType() === EventType.RoomName) {
    const name = typeof content.name === "string" ? sanitizeForTerminal(content.name) : "";
    return name ? `Room renamed to ${name}` : "Room name updated";
  }

  if (event.getType() === EventType.RoomTopic) {
    return "Topic updated";
  }

  if (event.getType() === EventType.RoomPowerLevels) {
    return "Power levels updated";
  }

  if (event.getType() === EventType.RoomJoinRules) {
    return "Join rules updated";
  }

  if (event.getType() === EventType.RoomHistoryVisibility) {
    return "History visibility updated";
  }

  if (event.getType() === EventType.RoomGuestAccess) {
    return "Guest access updated";
  }

  return null;
}

function getSenderLabel(room: Room, senderId: string): string {
  if (senderId.length === 0) {
    return "Unknown";
  }

  const member = room.getMember(senderId);
  const name = member?.name?.trim();

  return sanitizeForTerminal(name && name.length > 0 ? name : senderId);
}

function formatTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "--:--";
  }

  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function minuteBucket(timestamp: number): number {
  return Math.floor(timestamp / 60_000);
}

function sanitizeForTerminal(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join(" ");
}

function normalizeInputText(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\r\n?/g, " ")
    .replace(/[\n\u2028\u2029]/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function isControlText(value: string): boolean {
  return /^[\x00-\x1f\x7f]+$/.test(value);
}

function stripMouseInputText(value: string): string {
  return value.replace(/(?:\x1b?\[?<?)?\d+;\d+;\d+[mM]/g, "");
}

function wrapDisplayText(value: string, width: number): string[] {
  const text = sanitizeForTerminal(value);
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const char of Array.from(text)) {
    const charWidth = getCharDisplayWidth(char);

    if (currentWidth + charWidth > width && current.length > 0) {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }

    current += char;
    currentWidth += charWidth;
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}

function fitDisplayText(value: string, width: number): string {
  const text = sanitizeForTerminal(value);
  const truncated = truncateDisplayText(text, width);
  return padDisplayText(truncated, width);
}

function truncateDisplayText(value: string, width: number): string {
  if (getDisplayWidth(value) <= width) {
    return value;
  }

  if (width <= 1) {
    return "";
  }

  let result = "";
  let resultWidth = 0;
  const ellipsis = "...";
  const targetWidth = Math.max(0, width - ellipsis.length);

  for (const char of Array.from(value)) {
    const charWidth = getCharDisplayWidth(char);

    if (resultWidth + charWidth > targetWidth) {
      break;
    }

    result += char;
    resultWidth += charWidth;
  }

  return `${result}${ellipsis}`;
}

function sliceDisplayTextFromEnd(value: string, width: number): string {
  const chars = Array.from(sanitizeForTerminal(value)).reverse();
  let result = "";
  let resultWidth = 0;

  for (const char of chars) {
    const charWidth = getCharDisplayWidth(char);

    if (resultWidth + charWidth > width) {
      break;
    }

    result = `${char}${result}`;
    resultWidth += charWidth;
  }

  return result;
}

function padDisplayText(value: string, width: number): string {
  const text = truncateDisplayText(value, width);
  return `${text}${" ".repeat(Math.max(0, width - getDisplayWidth(text)))}`;
}

function centerText(value: string, width: number): string {
  const text = truncateDisplayText(sanitizeForTerminal(value), width);
  const left = Math.max(0, Math.floor((width - getDisplayWidth(text)) / 2));
  return padDisplayText(`${" ".repeat(left)}${text}`, width);
}

function padLines(lines: readonly string[], count: number, width: number): string[] {
  const padded = lines.map((line) => (line.includes("\x1b[") ? line : fitDisplayText(line, width)));

  while (padded.length < count) {
    padded.unshift(" ".repeat(width));
  }

  return padded;
}

function getDisplayWidth(value: string): number {
  let width = 0;

  for (const char of Array.from(value)) {
    width += getCharDisplayWidth(char);
  }

  return width;
}

function getCharDisplayWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;

  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }

  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
  ) {
    return 2;
  }

  return 1;
}

function formatError(error: unknown): string {
  return formatErrorMessage(error);
}

interface KeypressEvent {
  name?: string;
  ctrl?: boolean;
}
