import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getWorkspaceSurfaces, getWorkspaces, parseCmuxTreeJson } from "../src/cmux/client.js";
import {
  findNuggetWorkspace,
  findReusableRoomPane,
  findWorkspaceControllerSurface,
  shouldReuseRoomSurface,
  workspaceDescription,
  workspaceScore,
} from "../src/cmux/workspace-controller.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("parses cmux tree JSON and finds Nugget workspace surfaces", () => {
  const tree = parseCmuxTreeJson(fixture("cmux-tree-workspace.json"));
  const workspace = findNuggetWorkspace(tree, "!space:example.org", "Product");

  assert.equal(getWorkspaces(tree).length, 1);
  assert.equal(workspace?.ref, "workspace:1");
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
