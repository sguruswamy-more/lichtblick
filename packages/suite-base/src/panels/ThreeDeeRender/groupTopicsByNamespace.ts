// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import i18next from "i18next";

import { SettingsTreeAction, SettingsTreeNode, SettingsTreeNodes } from "@lichtblick/suite";

/** Prefix used for the keys of synthetic namespace group nodes in the displayed settings tree */
export const TOPIC_GROUP_KEY_PREFIX = "group:";

const TOPICS_ROOT_KEY = "topics";

type TrieNode = {
  /** Full namespace path of this trie node, e.g. "/navigation/path" */
  fullPath: string;
  /** Key of the topic settings node that lives exactly at this path, if any */
  topicKey?: string;
  children: Map<string, TrieNode>;
};

export type GroupedTopicsTree = {
  /** Settings tree to display, with the topics nested by namespace */
  nodes: SettingsTreeNodes;
  /** Translates an action coming from the displayed tree into actions on the original tree */
  toInternalActions: (action: SettingsTreeAction) => SettingsTreeAction[];
  /** Translates a path in the original tree into the corresponding path in the displayed tree */
  toDisplayPath: (path: readonly string[]) => readonly string[];
};

function isGroupKey(key: string | undefined): boolean {
  return key?.startsWith(TOPIC_GROUP_KEY_PREFIX) === true;
}

function splitTopicName(topicName: string): string[] {
  return topicName.split("/").filter((segment) => segment.length > 0);
}

function buildTrie(topicKeys: readonly string[]): TrieNode {
  const root: TrieNode = { fullPath: "", children: new Map() };
  for (const topicKey of topicKeys) {
    const segments = splitTopicName(topicKey);
    if (segments.length === 0) {
      // Nothing to nest by; keep the topic at the top level under its own key
      root.children.set(`\0${topicKey}`, {
        fullPath: topicKey,
        topicKey,
        children: new Map(),
      });
      continue;
    }
    let cur = root;
    for (const segment of segments) {
      let next = cur.children.get(segment);
      if (!next) {
        next = { fullPath: `${cur.fullPath}/${segment}`, children: new Map() };
        cur.children.set(segment, next);
      }
      cur = next;
    }
    if (cur.topicKey == undefined) {
      cur.topicKey = topicKey;
    } else {
      // Two distinct topic names normalize to the same path (e.g. "a/b" and "/a/b")
      cur.children.set(`\0${topicKey}`, {
        fullPath: topicKey,
        topicKey,
        children: new Map(),
      });
    }
  }
  return root;
}

/**
 * Nests the children of the "topics" settings node by their `/`-separated namespace. A group is
 * only created where two or more entries share a prefix; single-child chains are merged into one
 * label (e.g. "costmap/points"). Each group gets a visibility toggle that shows/hides all topics
 * within it.
 *
 * The original tree's paths are left untouched; the returned helpers translate paths and actions
 * between the displayed tree and the original one.
 */
export function groupTopicsByNamespace(tree: SettingsTreeNodes): GroupedTopicsTree {
  const topicsNode = tree[TOPICS_ROOT_KEY];
  const topicChildren = topicsNode?.children ?? {};
  const topicKeys = Object.keys(topicChildren).filter((key) => topicChildren[key] != undefined);

  /** Group keys from the topics node down to (not including) the topic */
  const ancestryByTopic = new Map<string, string[]>();
  /** All topic keys contained (recursively) within a group */
  const topicsByGroup = new Map<string, string[]>();

  const leafNode = (topicKey: string, label: string): SettingsTreeNode => {
    const node = topicChildren[topicKey]!;
    // Only shorten labels that were defaulted to the topic name, so custom labels are preserved
    if (node.label == undefined || node.label === topicKey) {
      return { ...node, label };
    }
    return node;
  };

  const emit = (
    trieNode: TrieNode,
    labelSegments: string[],
    ancestry: string[],
    out: Record<string, SettingsTreeNode>,
  ): string[] => {
    const childEntries = [...trieNode.children.entries()];
    const label = labelSegments.join("/");

    // Merge chains that have exactly one child and no topic of their own
    if (trieNode.topicKey == undefined && childEntries.length === 1) {
      const [segment, child] = childEntries[0]!;
      return emit(child, [...labelSegments, segment], ancestry, out);
    }

    // A plain topic with nothing nested beneath it
    if (trieNode.topicKey != undefined && childEntries.length === 0) {
      ancestryByTopic.set(trieNode.topicKey, ancestry);
      out[trieNode.topicKey] = leafNode(
        trieNode.topicKey,
        label.length > 0 ? label : trieNode.topicKey,
      );
      return [trieNode.topicKey];
    }

    // A namespace group
    const groupKey = `${TOPIC_GROUP_KEY_PREFIX}${trieNode.fullPath}`;
    const groupAncestry = [...ancestry, groupKey];
    const groupChildren: Record<string, SettingsTreeNode> = {};
    const members: string[] = [];
    if (trieNode.topicKey != undefined) {
      // A topic whose name is also the namespace of other topics, e.g. "/a" alongside "/a/b"
      ancestryByTopic.set(trieNode.topicKey, groupAncestry);
      groupChildren[trieNode.topicKey] = leafNode(
        trieNode.topicKey,
        labelSegments[labelSegments.length - 1] ?? trieNode.topicKey,
      );
      members.push(trieNode.topicKey);
    }
    for (const [segment, child] of childEntries) {
      const childLabel = segment.startsWith("\0") ? segment.slice(1) : segment;
      members.push(...emit(child, [childLabel], groupAncestry, groupChildren));
    }
    topicsByGroup.set(groupKey, members);

    const memberNodes = members.map((key) => topicChildren[key]!);
    const togglable = memberNodes.filter((node) => node.visible != undefined);
    const hasError = memberNodes.some((node) => node.error != undefined);

    out[groupKey] = {
      label,
      order: trieNode.fullPath.toLocaleLowerCase(),
      defaultExpansionState: "collapsed",
      visible: togglable.length > 0 ? togglable.some((node) => node.visible === true) : undefined,
      error: hasError ? i18next.t("threeDee:topicGroupHasErrors") : undefined,
      children: groupChildren,
    };
    return members;
  };

  const nestedChildren: Record<string, SettingsTreeNode> = {};
  const root = buildTrie(topicKeys);
  for (const [segment, child] of root.children) {
    const label = segment.startsWith("\0") ? segment.slice(1) : segment;
    emit(child, [label], [], nestedChildren);
  }

  const nodes: SettingsTreeNodes =
    topicsNode == undefined
      ? tree
      : {
          ...tree,
          [TOPICS_ROOT_KEY]: { ...topicsNode, children: nestedChildren },
        };

  const toInternalActions = (action: SettingsTreeAction): SettingsTreeAction[] => {
    const path = action.payload.path;
    if (path[0] !== TOPICS_ROOT_KEY || !isGroupKey(path[1])) {
      return [action];
    }
    // Strip the group keys between "topics" and the topic key
    let index = 1;
    while (isGroupKey(path[index])) {
      index++;
    }
    if (index < path.length && topicKeys.includes(path[index]!)) {
      return [
        {
          ...action,
          payload: {
            ...action.payload,
            path: [TOPICS_ROOT_KEY, ...path.slice(index)],
          },
        },
      ] as SettingsTreeAction[];
    }

    // The action targets a group node itself. Only the visibility toggle is supported.
    const groupKey = path[index - 1]!;
    if (
      action.action === "update" &&
      action.payload.input === "boolean" &&
      index === path.length - 1 &&
      path[index] === "visible"
    ) {
      const value = action.payload.value;
      return (topicsByGroup.get(groupKey) ?? [])
        .filter((topicKey) => topicChildren[topicKey]?.visible != undefined)
        .map((topicKey) => ({
          action: "update",
          payload: {
            input: "boolean",
            path: [TOPICS_ROOT_KEY, topicKey, "visible"],
            value,
          },
        }));
    }
    return [];
  };

  const toDisplayPath = (path: readonly string[]): readonly string[] => {
    const topicKey = path[1];
    if (path[0] !== TOPICS_ROOT_KEY || topicKey == undefined) {
      return path;
    }
    const ancestry = ancestryByTopic.get(topicKey);
    if (!ancestry || ancestry.length === 0) {
      return path;
    }
    return [TOPICS_ROOT_KEY, ...ancestry, ...path.slice(1)];
  };

  return { nodes, toInternalActions, toDisplayPath };
}
