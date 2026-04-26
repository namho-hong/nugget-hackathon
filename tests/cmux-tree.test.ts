import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CmuxClient,
  getWorkspaceSurfaces,
  getWorkspaces,
  parseCmuxTreeJson,
} from "../src/cmux/client.js";
import { createThreadAgentSurface } from "../src/cmux/sidecar-pane.js";
import {
  WorkspaceController,
  findNuggetWorkspace,
  findReusableRoomPane,
  findWorkspaceControllerSurface,
  shouldReuseRoomSurface,
  workspaceDescription,
  workspaceScore,
  workspaceTitle,
} from "../src/cmux/workspace-controller.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("parses cmux tree JSON and finds Nugget workspace surfaces", () => {
  const tree = parseCmuxTreeJson(fixture("cmux-tree-workspace.json"));
  const workspace = findNuggetWorkspace(tree, "!space:example.org", "Product");

  assert.equal(getWorkspaces(tree).length, 1);
  assert.equal(workspace?.ref, "workspace:1");
  assert.equal(workspace?.title, workspaceTitle("Product"));
  assert.equal(workspace?.description, workspaceDescription("!space:example.org"));
  assert.equal(findWorkspaceControllerSurface(workspace!, "!space:example.org")?.ref, "surface:1");
  assert.deepEqual(
    getWorkspaceSurfaces(workspace!).map((surface) => surface.ref),
    ["surface:1", "surface:2"],
  );
});

test("scores description matches above legacy title fallbacks", () => {
  const tree = parseCmuxTreeJson(fixture("cmux-tree-stale-pane.json"));
  const workspace = getWorkspaces(tree)[0]!;

  assert.equal(findNuggetWorkspace(tree, "!space:example.org", "Wrong Legacy")?.ref, "workspace:stale");
  assert.ok(workspaceScore(workspace, "!space:example.org") >= 1000);
});

test("finds legacy nugget workspace titles without emoji", () => {
  const tree = parseCmuxTreeJson(
    JSON.stringify({
      windows: [
        {
          workspaces: [
            {
              ref: "workspace:legacy",
              title: "nugget: Product",
            },
          ],
        },
      ],
    }),
  );

  assert.equal(findNuggetWorkspace(tree, "!space:example.org", "Product")?.ref, "workspace:legacy");
});

test("rejects malformed cmux tree output", () => {
  assert.throws(() => parseCmuxTreeJson("[]"), /non-object JSON/);
  assert.throws(() => parseCmuxTreeJson("{"), SyntaxError);
});

test("stale room surfaces are reused only after respawn and focus both succeed", () => {
  assert.equal(shouldReuseRoomSurface(true, true), true);
  assert.equal(shouldReuseRoomSurface(true, false), false);
  assert.equal(shouldReuseRoomSurface(false, false), false);
});

test("workspace room opens reuse an existing non-picker room pane", () => {
  const tree = parseCmuxTreeJson(fixture("cmux-tree-workspace.json"));
  const workspace = findNuggetWorkspace(tree, "!space:example.org", "Product");

  assert.equal(findReusableRoomPane(workspace!, "pane:1")?.ref, "pane:2");
});

test("workspace room pane reuse prefers the last opened room surface pane", () => {
  const tree = parseCmuxTreeJson(
    JSON.stringify({
      windows: [
        {
          workspaces: [
            {
              ref: "workspace:1",
              panes: [
                {
                  ref: "pane:picker",
                  surfaces: [{ ref: "surface:picker", title: "nugget workspace-controller" }],
                },
                {
                  ref: "pane:old-room",
                  surfaces: [{ ref: "surface:old", title: "nugget room !old:example.org" }],
                },
                {
                  ref: "pane:last-room",
                  surfaces: [{ ref: "surface:last", title: "nugget room !last:example.org" }],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const workspace = getWorkspaces(tree)[0]!;

  assert.equal(
    findReusableRoomPane(workspace, "pane:picker", "surface:last")?.ref,
    "pane:last-room",
  );
});

test("workspace controller resolves notification target to open room surface", async () => {
  const tree = parseCmuxTreeJson(fixture("cmux-tree-workspace.json"));
  const cmux = {
    tree: async () => tree,
  } as unknown as CmuxClient;
  const controller = new WorkspaceController(
    cmux,
    "workspace:1",
    "surface:1",
    "./nugget",
  );

  await controller.hydrateOpenRooms(["!room:example.org"]);

  assert.deepEqual(controller.getRoomNotificationTarget("!room:example.org"), {
    surfaceRef: "surface:2",
    workspaceRef: "workspace:1",
  });
  assert.deepEqual(controller.getRoomNotificationTarget("!unopened:example.org"), {
    surfaceRef: "surface:1",
    workspaceRef: "workspace:1",
  });
});

test("cmux notify passes explicit target refs", async () => {
  const cmux = new CmuxClient();
  const calls: string[][] = [];
  cmux.run = async (args: string[]) => {
    calls.push(args);
    return "";
  };

  await cmux.notify({
    body: "hello",
    surfaceRef: "surface:2",
    title: "Alice",
    workspaceRef: "workspace:1",
  });

  assert.deepEqual(calls, [
    [
      "notify",
      "--title",
      "Alice",
      "--body",
      "hello",
      "--workspace",
      "workspace:1",
      "--surface",
      "surface:2",
    ],
  ]);
});

test("thread and agent surfaces reuse the shared sidecar pane", async () => {
  const tree = parseCmuxTreeJson(
    JSON.stringify({
      windows: [
        {
          workspaces: [
            {
              ref: "workspace:1",
              panes: [
                {
                  ref: "pane:room",
                  surfaces: [{ ref: "surface:room", title: "codex project room" }],
                },
                {
                  ref: "pane:sidecar",
                  surfaces: [{ ref: "surface:thread", command: "NUGGET_THREAD_PANE=1 nugget thread" }],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const workspace = getWorkspaces(tree)[0]!;
  const calls: string[][] = [];
  const cmux = {
    newSurface: async (options: { paneRef: string; workspaceRef: string }) => {
      calls.push(["newSurface", options.paneRef, options.workspaceRef]);
      return {
        paneRef: options.paneRef,
        surfaceRef: "surface:new",
        workspaceRef: options.workspaceRef,
      };
    },
  } as unknown as CmuxClient;

  const target = await createThreadAgentSurface(cmux, {
    sourcePaneRef: "pane:room",
    sourceSurfaceRef: "surface:room",
    workspace,
    workspaceRef: "workspace:1",
  });

  assert.deepEqual(target, {
    paneRef: "pane:sidecar",
    surfaceRef: "surface:new",
    workspaceRef: "workspace:1",
  });
  assert.deepEqual(calls, [["newSurface", "pane:sidecar", "workspace:1"]]);
});
