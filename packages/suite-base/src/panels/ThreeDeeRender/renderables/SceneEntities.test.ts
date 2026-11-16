/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { SceneUpdate } from "@foxglove/schemas";
import { setupJestCanvasMock } from "jest-canvas-mock";

import { fromNanoSec } from "@lichtblick/rostime";
import { SettingsTreeNode } from "@lichtblick/suite";
import { Asset } from "@lichtblick/suite-base/components/PanelExtensionAdapter";
import { Renderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/Renderer";
import { DEFAULT_SCENE_EXTENSION_CONFIG } from "@lichtblick/suite-base/panels/ThreeDeeRender/SceneExtensionConfig";
import { DEFAULT_CAMERA_STATE } from "@lichtblick/suite-base/panels/ThreeDeeRender/camera";
import { DEFAULT_PUBLISH_SETTINGS } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/PublishSettings";

import { FoxgloveSceneEntities } from "./SceneEntities";
import { TopicEntities } from "./TopicEntities";
import { RendererConfig } from "../IRenderer";
import { PartialMessage, PartialMessageEvent } from "../SceneExtension";
import { LayerSettingsEntity } from "../settings";

jest.mock("../Picker", () => {
  const actual = jest.requireActual("../Picker");
  return {
    ...actual,
    Picker: jest.fn().mockImplementation(() => ({
      pick: jest.fn(() => -1),
      pickInstance: jest.fn(() => -1),
      dispose: jest.fn(),
    })),
  };
});

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "");

// WebGLRenderer is not available in jsdom
jest.mock("three", () => {
  const actualThree = jest.requireActual("three");
  return {
    ...actualThree,
    WebGLRenderer: function WebGLRenderer() {
      return {
        capabilities: { isWebGL2: true },
        setPixelRatio: jest.fn(),
        getPixelRatio: jest.fn(() => 1),
        setSize: jest.fn(),
        render: jest.fn(),
        clear: jest.fn(),
        setClearColor: jest.fn(),
        readRenderTargetPixels: jest.fn(),
        info: { reset: jest.fn() },
        shadowMap: {},
        dispose: jest.fn(),
        clearDepth: jest.fn(),
        getDrawingBufferSize: () => ({ width: 100, height: 100 }),
      };
    },
  };
});

const TOPIC = "/scene";
const FRAME = "map";

const fetchAsset = async (uri: string): Promise<Asset> => ({ uri, data: new Uint8Array() });

function makeConfig(): RendererConfig {
  return {
    cameraState: DEFAULT_CAMERA_STATE,
    followMode: "follow-pose",
    followTf: FRAME,
    scene: {},
    transforms: {},
    topics: { [TOPIC]: { visible: true } },
    layers: {},
    publish: DEFAULT_PUBLISH_SETTINGS,
    imageMode: {},
  };
}

const pose = { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
const color = { r: 1, g: 0, b: 0, a: 1 };

/** Builds a scene update with a single entity containing the given primitive arrays */
function makeSceneUpdateEvent(
  primitives: Record<string, unknown>,
): PartialMessageEvent<SceneUpdate> {
  const message = {
    entities: [
      {
        timestamp: fromNanoSec(1n),
        frame_id: FRAME,
        id: "entity",
        frame_locked: true,
        ...primitives,
      },
    ],
  } as PartialMessage<SceneUpdate>;
  return {
    topic: TOPIC,
    schemaName: "foxglove.SceneUpdate",
    receiveTime: fromNanoSec(1n),
    sizeInBytes: 0,
    message,
  };
}

const CUBES = { cubes: [{ pose, size: { x: 1, y: 1, z: 1 }, color }] };
const TEXTS = { texts: [{ pose, text: "hello", font_size: 12, color }] };
const LINES = {
  lines: [
    {
      pose,
      thickness: 0.1,
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
      ],
      color,
    },
  ],
};

describe("FoxgloveSceneEntities primitive visibility", () => {
  let renderer: Renderer;
  let extension: FoxgloveSceneEntities;

  const handleSceneUpdate = (event: PartialMessageEvent<SceneUpdate>) => {
    const subscription = extension.getSubscriptions()[0]!;
    if (subscription.type !== "schema") {
      throw new Error("Expected a schema subscription");
    }
    subscription.subscription.handler(event as never);
  };

  const topicNode = (): SettingsTreeNode | undefined =>
    renderer.settings.tree().topics?.children?.[TOPIC];

  const topicEntities = () =>
    (extension as unknown as { renderables: Map<string, TopicEntities> }).renderables.get(TOPIC)!;

  const primitiveRenderable = (primitiveType: string) =>
    topicEntities().children.find((child) => child.name.startsWith(`entity:${primitiveType} `));

  const setPrimitiveVisible = ({ key, visible }: { key: string; visible: boolean }) => {
    renderer.settings.handleAction({
      action: "update",
      payload: {
        input: "boolean",
        path: ["topics", TOPIC, `primitive:${key}`, "visible"],
        value: visible,
      },
    });
  };

  beforeEach(() => {
    setupJestCanvasMock();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: ReactNull,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });

    const canvas = document.createElement("canvas");
    document.createElement("div").appendChild(canvas);
    renderer = new Renderer({
      canvas,
      config: makeConfig(),
      interfaceMode: "3d",
      fetchAsset,
      sceneExtensionConfig: DEFAULT_SCENE_EXTENSION_CONFIG,
      testOptions: {},
      customCameraModels: new Map(),
    });
    renderer.setTopics([{ name: TOPIC, schemaName: "foxglove.SceneUpdate" }]);
    renderer.addTransform(FRAME, "base_link", 0n, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    extension = renderer.sceneExtensions.get(
      FoxgloveSceneEntities.extensionId,
    ) as FoxgloveSceneEntities;
  });

  afterEach(() => {
    renderer.dispose();
    (console.warn as jest.Mock).mockClear();
  });

  it("does not add primitive nodes before any message is received", () => {
    expect(topicNode()).toBeDefined();
    expect(topicNode()!.children).toBeUndefined();
  });

  it("adds a node for each primitive type received on the topic", () => {
    // When: A scene update with cubes and texts arrives
    handleSceneUpdate(makeSceneUpdateEvent({ ...CUBES, ...TEXTS }));

    // Then: Only those primitive types are listed, all visible by default
    const children = topicNode()!.children!;
    expect(Object.keys(children)).toEqual(["primitive:cubes", "primitive:texts"]);
    expect(children["primitive:cubes"]).toMatchObject({ label: "Cubes", visible: true });
    expect(children["primitive:texts"]).toMatchObject({ label: "Texts", visible: true });

    // When: A new primitive type appears later
    handleSceneUpdate(makeSceneUpdateEvent({ ...LINES }));

    // Then: It is added to the settings tree
    expect(Object.keys(topicNode()!.children!)).toContain("primitive:lines");
  });

  it("hides only the toggled primitive type and persists the setting", () => {
    // Given: An entity with cubes and texts
    handleSceneUpdate(makeSceneUpdateEvent({ ...CUBES, ...TEXTS }));

    // When: Texts are hidden for the topic
    setPrimitiveVisible({ key: "texts", visible: false });
    extension.startFrame(1n, FRAME, FRAME);

    // Then: The config and settings tree are updated
    expect(renderer.config.topics[TOPIC]).toMatchObject({
      visible: true,
      primitives: { texts: { visible: false } },
    });
    expect(topicNode()!.children!["primitive:texts"]!.visible).toBe(false);
    expect(topicNode()!.visible).toBe(true);

    // And: Only the texts are hidden in the scene
    expect(primitiveRenderable("TEXTS")!.visible).toBe(false);
    expect(primitiveRenderable("CUBES")!.visible).toBe(true);

    // When: Texts are shown again
    setPrimitiveVisible({ key: "texts", visible: true });
    extension.startFrame(1n, FRAME, FRAME);

    // Then: They are rendered again
    expect(primitiveRenderable("TEXTS")!.visible).toBe(true);
  });

  it("applies a hidden primitive type to entities received after the toggle", () => {
    // Given: Cubes are hidden before any cube arrives
    handleSceneUpdate(makeSceneUpdateEvent({ ...TEXTS }));
    const settings: Partial<LayerSettingsEntity> = {
      visible: true,
      primitives: { cubes: { visible: false } },
    };
    renderer.updateConfig((draft) => {
      draft.topics[TOPIC] = settings;
    });
    extension.handleSettingsAction({
      action: "update",
      payload: { input: "boolean", path: ["topics", TOPIC, "visible"], value: true },
    });

    // When: An entity with cubes arrives
    handleSceneUpdate(makeSceneUpdateEvent({ ...CUBES, ...TEXTS }));
    extension.startFrame(1n, FRAME, FRAME);

    // Then: The cubes stay hidden
    expect(topicNode()!.children!["primitive:cubes"]!.visible).toBe(false);
    expect(primitiveRenderable("CUBES")!.visible).toBe(false);
    expect(primitiveRenderable("TEXTS")!.visible).toBe(true);
  });
});
