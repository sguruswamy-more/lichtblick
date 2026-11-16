// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { SettingsTreeNode, SettingsTreeNodes } from "@lichtblick/suite";

import { groupTopicsByNamespace } from "./groupTopicsByNamespace";

function makeTree(topics: Record<string, Partial<SettingsTreeNode>>): SettingsTreeNodes {
  const children: Record<string, SettingsTreeNode> = {};
  for (const [name, node] of Object.entries(topics)) {
    children[name] = { label: name, visible: true, ...node };
  }
  return {
    general: { label: "Frame" },
    topics: { label: "Topics", children },
  };
}

/** Converts the displayed tree into a compact { key: label | subtree } shape for assertions */
function shape(nodes: SettingsTreeNodes | undefined): unknown {
  const result: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(nodes ?? {})) {
    result[key] = node?.children
      ? { label: node.label, children: shape(node.children) }
      : node?.label;
  }
  return result;
}

describe("groupTopicsByNamespace", () => {
  it("nests topics at multiple levels and merges single-child chains", () => {
    const tree = makeTree({
      "/navigation/path/xyz": {},
      "/navigation/path/something": {},
      "/navigation/costmap/points": {},
      "/tf": {},
    });

    const { nodes } = groupTopicsByNamespace(tree);

    expect(shape(nodes.topics!.children)).toEqual({
      "group:/navigation": {
        label: "navigation",
        children: {
          "group:/navigation/path": {
            label: "path",
            children: {
              "/navigation/path/xyz": "xyz",
              "/navigation/path/something": "something",
            },
          },
          "/navigation/costmap/points": "costmap/points",
        },
      },
      "/tf": "tf",
    });
    // Other top level nodes are untouched
    expect(nodes.general).toBe(tree.general);
  });

  it("merges a chain of namespaces above a group into the group's label", () => {
    const tree = makeTree({ "/robot/arm/a": {}, "/robot/arm/b": {} });

    const { nodes } = groupTopicsByNamespace(tree);

    expect(shape(nodes.topics!.children)).toEqual({
      "group:/robot/arm": {
        label: "robot/arm",
        children: { "/robot/arm/a": "a", "/robot/arm/b": "b" },
      },
    });
  });

  it("places a topic that is also a namespace inside its group", () => {
    const tree = makeTree({ "/scan": {}, "/scan/filtered": {} });

    const { nodes } = groupTopicsByNamespace(tree);

    expect(shape(nodes.topics!.children)).toEqual({
      "group:/scan": {
        label: "scan",
        children: { "/scan": "scan", "/scan/filtered": "filtered" },
      },
    });
  });

  it("preserves custom labels", () => {
    const tree = makeTree({ "/a/b": { label: "Custom" }, "/a/c": {} });

    const { nodes } = groupTopicsByNamespace(tree);

    expect(nodes.topics!.children!["group:/a"]!.children!["/a/b"]!.label).toBe("Custom");
  });

  it("derives group visibility and errors from its topics", () => {
    const tree = makeTree({
      "/a/x": { visible: false },
      "/a/y": { visible: true, error: "bad" },
      "/b/x": { visible: false },
      "/b/y": { visible: false },
    });

    const children = groupTopicsByNamespace(tree).nodes.topics!.children!;

    expect(children["group:/a"]!.visible).toBe(true);
    expect(children["group:/a"]!.error).toBeDefined();
    expect(children["group:/b"]!.visible).toBe(false);
    expect(children["group:/b"]!.error).toBeUndefined();
  });

  it("maps actions on nested topics back to their flat paths", () => {
    const tree = makeTree({ "/a/b/x": {}, "/a/b/y": {}, "/a/z": {} });
    const { toInternalActions } = groupTopicsByNamespace(tree);

    expect(
      toInternalActions({
        action: "update",
        payload: {
          input: "rgba",
          path: ["topics", "group:/a", "group:/a/b", "/a/b/x", "color"],
          value: "#fff",
        },
      }),
    ).toEqual([
      {
        action: "update",
        payload: {
          input: "rgba",
          path: ["topics", "/a/b/x", "color"],
          value: "#fff",
        },
      },
    ]);
  });

  it("expands a group visibility toggle into one update per topic", () => {
    const tree = makeTree({
      "/a/b/x": {},
      "/a/b/y": {},
      "/a/z": {},
      "/other": {},
    });
    const { toInternalActions } = groupTopicsByNamespace(tree);

    const actions = toInternalActions({
      action: "update",
      payload: {
        input: "boolean",
        path: ["topics", "group:/a", "visible"],
        value: false,
      },
    });

    expect(actions.map((action) => action.payload.path)).toEqual([
      ["topics", "/a/b/x", "visible"],
      ["topics", "/a/b/y", "visible"],
      ["topics", "/a/z", "visible"],
    ]);
    expect(
      actions.every((action) => action.action === "update" && action.payload.value === false),
    ).toBe(true);
  });

  it("passes through actions outside of groups unchanged", () => {
    const { toInternalActions } = groupTopicsByNamespace(makeTree({ "/a/x": {}, "/a/y": {} }));
    const action = {
      action: "perform-node-action" as const,
      payload: { id: "show-all", path: ["topics"] },
    };

    expect(toInternalActions(action)).toEqual([action]);
  });

  it("maps flat topic paths to their display paths", () => {
    const { toDisplayPath } = groupTopicsByNamespace(
      makeTree({ "/a/b/x": {}, "/a/b/y": {}, "/a/z": {}, "/solo": {} }),
    );

    expect(toDisplayPath(["topics", "/a/b/x"])).toEqual([
      "topics",
      "group:/a",
      "group:/a/b",
      "/a/b/x",
    ]);
    expect(toDisplayPath(["topics", "/solo"])).toEqual(["topics", "/solo"]);
    expect(toDisplayPath(["general"])).toEqual(["general"]);
  });

  it("handles a tree without a topics node", () => {
    const tree: SettingsTreeNodes = { general: { label: "Frame" } };

    expect(groupTopicsByNamespace(tree).nodes).toBe(tree);
  });
});
