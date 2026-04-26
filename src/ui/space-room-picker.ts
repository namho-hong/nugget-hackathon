import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

import type { SpaceRoom } from "../matrix/index.js";
import { truncateDisplayText } from "../util/terminal.js";
import { promptRequiredNavigation } from "./prompts.js";

interface SpaceRoomPickerIo {
  input: ReadStream;
  output: WriteStream;
}

type PickerAction =
  | { type: "open-room"; roomId: string }
  | { type: "join-room"; roomId: string }
  | { type: "accept-room-invite"; roomId: string }
  | { type: "invite-user" }
  | { type: "refresh" }
  | { type: "home" }
  | { type: "quit" };

export type SpaceRoomPickerResult = { type: "home" } | { type: "quit" };

interface PickerOption {
  label: string;
  action: PickerAction;
  disabled?: false;
}

interface DisabledPickerOption {
  label: string;
  disabled: true;
}

type AnyPickerOption = PickerOption | DisabledPickerOption;

export async function runSpaceRoomPicker(options: {
  title: string;
  loadRooms: () => Promise<readonly SpaceRoom[]> | readonly SpaceRoom[];
  onOpenRoom: (roomId: string) => Promise<void>;
  onJoinRoom?: (room: SpaceRoom) => Promise<void>;
  onAcceptRoomInvite?: (room: SpaceRoom) => Promise<void>;
  onInviteUser?: (userId: string) => Promise<void>;
  watchRoomActivity?: (onActivity: (roomId: string) => void) => () => void;
  io?: SpaceRoomPickerIo;
}): Promise<SpaceRoomPickerResult> {
  const io = options.io ?? { input: process.stdin, output: process.stdout };
  const canInviteUser = options.onInviteUser !== undefined;

  if (!io.input.isTTY || !io.output.isTTY) {
    const rooms = await options.loadRooms();
    io.output.write(
      renderPicker(options.title, rooms, -1, io.output.columns ?? 80, "", canInviteUser),
    );
    return { type: "quit" };
  }

  let rooms = await options.loadRooms();
  let selectedIndex = 0;
  let notice = "";
  let ignoreInitialEnter = process.env.NUGGET_IGNORE_INITIAL_ENTER === "1";
  let closed = false;
  const activeRoomIds = new Set<string>();
  let stopWatchingActivity: (() => void) | null = null;

  emitKeypressEvents(io.input);
  io.input.resume();
  io.input.setRawMode(true);
  io.output.write("\x1b[?25l");

  const render = (): void => {
    if (closed) {
      return;
    }

    const selectableCount = selectableOptions(rooms, canInviteUser).length;
    selectedIndex = selectableCount === 0 ? 0 : selectedIndex % selectableCount;
    io.output.write(
      `\x1b[2J\x1b[H${renderPicker(
        options.title,
        rooms,
        selectedIndex,
        io.output.columns ?? 80,
        notice,
        canInviteUser,
        activeRoomIds,
      )}`,
    );
  };

  let resolveDone: ((result: SpaceRoomPickerResult) => void) | null = null;

  let cleanup = (result: SpaceRoomPickerResult): void => {
    if (closed) {
      return;
    }

    closed = true;
    stopWatchingActivity?.();
    stopWatchingActivity = null;
    io.input.off("keypress", onKeypress);
    io.output.off("resize", render);

    if (io.input.isRaw) {
      io.input.setRawMode(false);
    }

    io.output.write("\x1b[?25h\x1b[0m\n");
    resolveDone?.(result);
  };

  const refresh = async (): Promise<void> => {
    rooms = await options.loadRooms();
    pruneActivity(activeRoomIds, rooms);
    render();
  };

  const finish = (result: SpaceRoomPickerResult): void => {
    cleanup(result);
  };

  const onKeypress = async (_text: string, key: KeypressEvent): Promise<void> => {
    if (closed) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      finish({ type: "quit" });
      return;
    }

    if (key.name === "escape" || key.name === "q") {
      finish({ type: "quit" });
      return;
    }

    const selectable = selectableOptions(rooms, canInviteUser);

    if (selectable.length === 0) {
      return;
    }

    if (key.name === "up" || key.name === "k") {
      selectedIndex = (selectedIndex - 1 + selectable.length) % selectable.length;
      render();
      return;
    }

    if (key.name === "down" || key.name === "j") {
      selectedIndex = (selectedIndex + 1) % selectable.length;
      render();
      return;
    }

    if (key.name === "r") {
      notice = "Refreshing rooms...";
      render();
      await refresh();
      notice = "";
      render();
      return;
    }

    if (key.name !== "return" && key.name !== "enter") {
      return;
    }

    if (ignoreInitialEnter) {
      ignoreInitialEnter = false;
      return;
    }

    const selected = selectable[selectedIndex];

    if (!selected) {
      return;
    }

    if (selected.action.type === "quit") {
      finish({ type: "quit" });
      return;
    }

    if (selected.action.type === "home") {
      finish({ type: "home" });
      return;
    }

    if (selected.action.type === "refresh") {
      notice = "Refreshing rooms...";
      render();
      await refresh();
      notice = "";
      render();
      return;
    }

    if (selected.action.type === "invite-user") {
      const result = await promptForInviteUserId(io, onKeypress);

      if (typeof result !== "string") {
        finish(result);
        return;
      }

      if (!isMatrixUserId(result)) {
        notice = `Invalid Matrix user ID: ${result}`;
        render();
        return;
      }

      notice = `Inviting ${result}...`;
      render();

      try {
        await options.onInviteUser?.(result);
        notice = `Invited ${result}.`;
      } catch (error) {
        notice = error instanceof Error ? error.message : String(error);
      }

      render();
      return;
    }

    if (!("roomId" in selected.action)) {
      return;
    }

    const selectedRoomId = selected.action.roomId;
    const selectedRoom = rooms.find((room) => room.roomId === selectedRoomId);

    if (!selectedRoom) {
      notice = "Room is no longer visible. Refreshing...";
      render();
      await refresh();
      notice = "";
      render();
      return;
    }

    if (selected.action.type === "join-room") {
      notice = `Joining ${selectedRoom.name}...`;
      render();

      try {
        await options.onJoinRoom?.(selectedRoom);
        notice = `Joined ${selectedRoom.name}.`;
        await refresh();
      } catch (error) {
        notice = error instanceof Error ? error.message : String(error);
      }

      render();
      return;
    }

    if (selected.action.type === "accept-room-invite") {
      notice = `Accepting invite to ${selectedRoom.name}...`;
      render();

      try {
        await options.onAcceptRoomInvite?.(selectedRoom);
        notice = `Accepted invite to ${selectedRoom.name}.`;
        await refresh();
      } catch (error) {
        notice = error instanceof Error ? error.message : String(error);
      }

      render();
      return;
    }

    try {
      notice = `Opening ${selectedRoom.name}...`;
      activeRoomIds.delete(selectedRoom.roomId);
      render();
      await options.onOpenRoom(selectedRoom.roomId);
      notice = `Opened ${selectedRoom.name}.`;
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    }

    render();
  };

  return await new Promise<SpaceRoomPickerResult>((resolve) => {
    resolveDone = resolve;
    io.input.on("keypress", onKeypress);
    io.output.on("resize", render);
    stopWatchingActivity =
      options.watchRoomActivity?.((roomId) => {
        if (closed || !rooms.some((room) => room.roomId === roomId)) {
          return;
        }

        activeRoomIds.add(roomId);
        render();
      }) ?? null;
    render();
  });
}

function renderPicker(
  title: string,
  rooms: readonly SpaceRoom[],
  selectedIndex: number,
  columns: number,
  notice = "",
  canInviteUser = false,
  activeRoomIds: ReadonlySet<string> = new Set(),
): string {
  const width = Math.max(20, columns);
  const lines = [title, ""];
  const options = pickerOptions(rooms, canInviteUser);
  let optionIndex = 0;

  for (const option of options) {
    const isSelected = !option.disabled && optionIndex === selectedIndex;
    const prefix = option.disabled ? "  " : isSelected ? "> " : "  ";

    if (!option.disabled) {
      optionIndex += 1;
    }

    lines.push(`${prefix}${truncate(optionLabel(option, activeRoomIds), width - 4)}`);
  }

  if (notice.length > 0) {
    lines.push("", truncate(notice, width));
  }

  lines.push("", "Enter selects, r refreshes, q quits.");
  return `${lines.join("\n")}\n`;
}

function selectableOptions(
  rooms: readonly SpaceRoom[],
  canInviteUser: boolean,
): PickerOption[] {
  return pickerOptions(rooms, canInviteUser).filter(
    (option): option is PickerOption => !option.disabled,
  );
}

function pickerOptions(
  rooms: readonly SpaceRoom[],
  canInviteUser: boolean,
): AnyPickerOption[] {
  const roomOptions: AnyPickerOption[] =
    rooms.length === 0
      ? [{ label: "No rooms in this workspace", disabled: true }]
      : rooms.map((room) => roomOption(room));

  return [
    ...roomOptions,
    ...(canInviteUser
      ? [{ label: "Invite user", action: { type: "invite-user" } } satisfies PickerOption]
      : []),
    { label: "Refresh", action: { type: "refresh" } },
    { label: "Home", action: { type: "home" } },
    { label: "Quit", action: { type: "quit" } },
  ];
}

function optionLabel(option: AnyPickerOption, activeRoomIds: ReadonlySet<string>): string {
  if (option.disabled || option.action.type !== "open-room") {
    return option.label;
  }

  return activeRoomIds.has(option.action.roomId) ? `* ${option.label}` : option.label;
}

function roomOption(room: SpaceRoom): AnyPickerOption {
  const label = `${room.name}  ${statusLabel(room)}`;

  if (room.status === "joined") {
    return {
      label,
      action: { type: "open-room", roomId: room.roomId },
    };
  }

  if (room.status === "invited") {
    return {
      label,
      action: { type: "accept-room-invite", roomId: room.roomId },
    };
  }

  if (room.status === "joinable") {
    return {
      label,
      action: { type: "join-room", roomId: room.roomId },
    };
  }

  return {
    label,
    disabled: true,
  };
}

function statusLabel(room: SpaceRoom): string {
  if (room.status === "joined") {
    return "Joined";
  }

  if (room.status === "invited") {
    return "Invite pending";
  }

  if (room.status === "joinable") {
    return "Join";
  }

  return "No access";
}

function pruneActivity(activeRoomIds: Set<string>, rooms: readonly SpaceRoom[]): void {
  const roomIds = new Set(rooms.map((room) => room.roomId));

  for (const roomId of activeRoomIds) {
    if (!roomIds.has(roomId)) {
      activeRoomIds.delete(roomId);
    }
  }
}

async function promptForInviteUserId(
  io: SpaceRoomPickerIo,
  onKeypress: (text: string, key: KeypressEvent) => Promise<void>,
): Promise<string | SpaceRoomPickerResult> {
  io.input.off("keypress", onKeypress);
  io.input.setRawMode(false);
  io.output.write("\x1b[?25h\x1b[0m\n");

  try {
    const result = await promptRequiredNavigation("Matrix user ID", io);

    if (result.type === "value") {
      return result.value.trim();
    }

    return result;
  } finally {
    io.input.on("keypress", onKeypress);
    io.input.setRawMode(true);
    io.output.write("\x1b[?25l");
  }
}

function isMatrixUserId(value: string): boolean {
  return /^@[^:\s]+:.+$/.test(value);
}

function truncate(value: string, maxLength: number): string {
  return truncateDisplayText(value, maxLength);
}

interface KeypressEvent {
  name?: string;
  ctrl?: boolean;
}
