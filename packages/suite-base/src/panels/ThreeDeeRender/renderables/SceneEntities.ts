// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  ArrowPrimitive,
  CubePrimitive,
  CylinderPrimitive,
  LinePrimitive,
  LineType,
  ModelPrimitive,
  SceneEntity,
  SceneEntityDeletion,
  SceneEntityDeletionType,
  SceneUpdate,
  SpherePrimitive,
  TextPrimitive,
  TriangleListPrimitive,
} from "@foxglove/schemas";
import { t } from "i18next";
import * as _ from "lodash-es";

import { toNanoSec } from "@lichtblick/rostime";
import { SettingsTreeAction } from "@lichtblick/suite";

import { TopicEntities } from "./TopicEntities";
import type { AnyRendererSubscription, IRenderer } from "../IRenderer";
import { SELECTED_ID_VARIABLE } from "../Renderable";
import { PartialMessage, PartialMessageEvent, SceneExtension } from "../SceneExtension";
import { SettingsTreeEntry, SettingsTreeNodeWithActionHandler } from "../SettingsManager";
import { SCENE_UPDATE_DATATYPES } from "../foxglove";
import {
  normalizeColorRGBA,
  normalizeColorRGBAs,
  normalizePose,
  normalizeTime,
  normalizeVector3,
  normalizeByteArray,
} from "../normalizeMessages";
import { LayerSettingsEntity } from "../settings";
import { topicIsConvertibleToSchema } from "../topicIsConvertibleToSchema";
import { makePose } from "../transforms";
import { PrimitivePool } from "./primitives/PrimitivePool";
import { ALL_PRIMITIVE_TYPES, PRIMITIVE_KEYS, PrimitiveKey } from "./primitives/constants";

/** Prefix for the keys of per primitive type nodes under a topic in the settings tree */
const PRIMITIVE_NODE_KEY_PREFIX = "primitive:";

const PRIMITIVE_LABEL_KEYS = {
  arrows: "threeDee:primitiveArrows",
  cubes: "threeDee:primitiveCubes",
  cylinders: "threeDee:primitiveCylinders",
  lines: "threeDee:primitiveLines",
  models: "threeDee:primitiveModels",
  spheres: "threeDee:primitiveSpheres",
  texts: "threeDee:primitiveTexts",
  triangles: "threeDee:primitiveTriangles",
} as const satisfies Record<PrimitiveKey, string>;

const SCENE_ENTITIES_DEFAULT_SETTINGS: LayerSettingsEntity = {
  showOutlines: true,
  visible: false,
  color: undefined,
  selectedIdVariable: undefined,
};

export class FoxgloveSceneEntities extends SceneExtension<TopicEntities> {
  public static extensionId = "foxglove.SceneEntities";
  #primitivePool = new PrimitivePool(this.renderer);

  public constructor(renderer: IRenderer, name: string = FoxgloveSceneEntities.extensionId) {
    super(name, renderer);
  }
  public override getSubscriptions(): readonly AnyRendererSubscription[] {
    return [
      {
        type: "schema",
        schemaNames: SCENE_UPDATE_DATATYPES,
        subscription: { handler: this.#handleSceneUpdate },
      },
    ];
  }

  public override settingsNodes(): SettingsTreeEntry[] {
    const configTopics = this.renderer.config.topics;
    const entries: SettingsTreeEntry[] = [];
    for (const topic of this.renderer.topics ?? []) {
      if (!topicIsConvertibleToSchema(topic, SCENE_UPDATE_DATATYPES)) {
        continue;
      }
      const config = (configTopics[topic.name] ?? {}) as Partial<LayerSettingsEntity>;

      const node: SettingsTreeNodeWithActionHandler = {
        label: topic.name,
        icon: "Shapes",
        order: topic.name.toLocaleLowerCase(),
        fields: {
          color: { label: "Color", input: "rgba", value: config.color },
          showOutlines: {
            label: "Show outlines",
            input: "boolean",
            value: config.showOutlines ?? SCENE_ENTITIES_DEFAULT_SETTINGS.showOutlines,
          },
          selectedIdVariable: {
            label: "Selection Variable",
            input: "string",
            help: "When selecting a SceneEntity, this global variable will be set to the entity ID",
            value: config.selectedIdVariable,
            placeholder: SELECTED_ID_VARIABLE,
          },
        },
        visible: config.visible ?? SCENE_ENTITIES_DEFAULT_SETTINGS.visible,
        handler: this.handleSettingsAction,
      };

      // Add a visibility toggle for each primitive type that has been received on this topic
      const primitiveTypes = this.renderables.get(topic.name)?.primitiveTypes;
      if (primitiveTypes && primitiveTypes.size > 0) {
        node.children = {};
        ALL_PRIMITIVE_TYPES.forEach((primitiveType, index) => {
          if (!primitiveTypes.has(primitiveType)) {
            return;
          }
          const key = PRIMITIVE_KEYS[primitiveType];
          const child: SettingsTreeNodeWithActionHandler = {
            label: t(PRIMITIVE_LABEL_KEYS[key]),
            icon: "Shapes",
            order: index,
            visible: config.primitives?.[key]?.visible ?? true,
            handler: this.#handleSettingsActionPrimitive,
          };
          node.children![`${PRIMITIVE_NODE_KEY_PREFIX}${key}`] = child;
        });
      }

      entries.push({ path: ["topics", topic.name], node });
    }
    return entries;
  }

  public override startFrame(
    currentTime: bigint,
    renderFrameId: string,
    fixedFrameId: string,
  ): void {
    // Don't use SceneExtension#startFrame() because our renderables represent one topic each with
    // many entities. Instead, call startFrame on each renderable
    for (const renderable of this.renderables.values()) {
      renderable.startFrame(currentTime, renderFrameId, fixedFrameId);
    }
  }

  public override setColorScheme(
    colorScheme: "dark" | "light",
    _backgroundColor: THREE.Color | undefined,
  ): void {
    for (const renderable of this.renderables.values()) {
      renderable.setColorScheme(colorScheme);
    }
  }

  public override handleSettingsAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;
    if (action.action !== "update" || path.length !== 3) {
      return;
    }

    this.saveSetting(path, action.payload.value);

    // Update the TopicEntities settings
    const topicName = path[1]!;
    const renderable = this.renderables.get(topicName);
    if (renderable) {
      const settings = this.renderer.config.topics[topicName];
      renderable.userData.settings = { ...SCENE_ENTITIES_DEFAULT_SETTINGS, ...settings };
      renderable.updateSettings();
    }
  };

  #handleSettingsActionPrimitive = (action: SettingsTreeAction): void => {
    const path = action.payload.path;
    if (action.action !== "update" || path.length !== 4) {
      return;
    }

    // The settings tree uses paths of the form
    //   ["topics", <topic>, "primitive:"<key>, <field>]
    // while the config is stored at
    //   ["topics", <topic>, "primitives", <key>, <field>]
    const topicName = path[1]!;
    const primitiveKey = path[2]!.slice(PRIMITIVE_NODE_KEY_PREFIX.length) as PrimitiveKey;
    const fieldName = path[3]!;
    this.renderer.updateConfig((draft) => {
      _.set(
        draft,
        ["topics", topicName, "primitives", primitiveKey, fieldName],
        action.payload.value,
      );
    });

    const renderable = this.renderables.get(topicName);
    if (renderable) {
      const settings = this.renderer.config.topics[topicName];
      renderable.userData.settings = { ...SCENE_ENTITIES_DEFAULT_SETTINGS, ...settings };
    }

    this.updateSettingsTree();
  };

  #handleSceneUpdate = (messageEvent: PartialMessageEvent<SceneUpdate>): void => {
    const topic = messageEvent.topic;
    const sceneUpdates = messageEvent.message;
    const prevPrimitiveTypeCount = this.renderables.get(topic)?.primitiveTypes.size ?? 0;

    for (const deletionMsg of sceneUpdates.deletions ?? []) {
      if (deletionMsg) {
        const deletion = normalizeSceneEntityDeletion(deletionMsg);
        this.#getTopicEntities(topic).deleteEntities(deletion);
      }
    }

    for (const entityMsg of sceneUpdates.entities ?? []) {
      if (entityMsg) {
        const entity = normalizeSceneEntity(entityMsg);
        this.#getTopicEntities(topic).addOrUpdateEntity(
          entity,
          toNanoSec(messageEvent.receiveTime),
        );
      }
    }

    // If a new primitive type appeared on this topic, rebuild its settings node
    if ((this.renderables.get(topic)?.primitiveTypes.size ?? 0) !== prevPrimitiveTypeCount) {
      this.updateSettingsTree();
    }
  };

  #getTopicEntities(topic: string): TopicEntities {
    let topicEntities = this.renderables.get(topic);
    if (!topicEntities) {
      const userSettings = this.renderer.config.topics[topic];

      topicEntities = new TopicEntities(topic, this.#primitivePool, this.renderer, {
        receiveTime: -1n,
        messageTime: -1n,
        frameId: "",
        pose: makePose(),
        settingsPath: ["topics", topic],
        topic,
        settings: { ...SCENE_ENTITIES_DEFAULT_SETTINGS, ...userSettings },
      });
      this.renderables.set(topic, topicEntities);
      this.add(topicEntities);
    }
    return topicEntities;
  }

  public override dispose(): void {
    super.dispose();
    this.#primitivePool.dispose();
  }
}

function normalizeSceneEntity(entity: PartialMessage<SceneEntity>): SceneEntity {
  return {
    timestamp: normalizeTime(entity.timestamp),
    frame_id: entity.frame_id ?? "",
    id: entity.id ?? "",
    lifetime: normalizeTime(entity.lifetime),
    frame_locked: entity.frame_locked ?? false,
    metadata: entity.metadata?.map((kv) => ({ key: kv?.key ?? "", value: kv?.value ?? "" })) ?? [],
    arrows: entity.arrows?.map(normalizeArrowPrimitive) ?? [],
    cubes: entity.cubes?.map(normalizeCubePrimitive) ?? [],
    spheres: entity.spheres?.map(normalizeSpherePrimitive) ?? [],
    cylinders: entity.cylinders?.map(normalizeCylinderPrimitive) ?? [],
    lines: entity.lines?.map(normalizeLinePrimitive) ?? [],
    triangles: entity.triangles?.map(normalizeTriangleListPrimitive) ?? [],
    texts: entity.texts?.map(normalizeTextPrimitive) ?? [],
    models: entity.models?.map(normalizeModelPrimitive) ?? [],
  };
}

function normalizeSceneEntityDeletion(
  entity: PartialMessage<SceneEntityDeletion>,
): SceneEntityDeletion {
  return {
    timestamp: normalizeTime(entity.timestamp),
    type: entity.type ?? SceneEntityDeletionType.MATCHING_ID,
    id: entity.id ?? "",
  };
}

function normalizeArrowPrimitive(
  arrow: PartialMessage<ArrowPrimitive> | undefined,
): ArrowPrimitive {
  return {
    pose: normalizePose(arrow?.pose),
    shaft_length: arrow?.shaft_length ?? 0.8,
    shaft_diameter: arrow?.shaft_diameter ?? 0.1,
    head_length: arrow?.head_length ?? 0.2,
    head_diameter: arrow?.head_diameter ?? 0.2,
    color: normalizeColorRGBA(arrow?.color),
  };
}

function normalizeCubePrimitive(cube: PartialMessage<CubePrimitive> | undefined): CubePrimitive {
  return {
    pose: normalizePose(cube?.pose),
    size: normalizeVector3(cube?.size),
    color: normalizeColorRGBA(cube?.color),
  };
}

function normalizeSpherePrimitive(
  sphere: PartialMessage<SpherePrimitive> | undefined,
): SpherePrimitive {
  return {
    pose: normalizePose(sphere?.pose),
    size: normalizeVector3(sphere?.size),
    color: normalizeColorRGBA(sphere?.color),
  };
}

function normalizeCylinderPrimitive(
  cylinder: PartialMessage<CylinderPrimitive> | undefined,
): CylinderPrimitive {
  return {
    pose: normalizePose(cylinder?.pose),
    size: normalizeVector3(cylinder?.size),
    bottom_scale: cylinder?.bottom_scale ?? 1,
    top_scale: cylinder?.top_scale ?? 1,
    color: normalizeColorRGBA(cylinder?.color),
  };
}

function normalizeLinePrimitive(line: PartialMessage<LinePrimitive> | undefined): LinePrimitive {
  return {
    type: line?.type ?? LineType.LINE_STRIP,
    pose: normalizePose(line?.pose),
    thickness: line?.thickness ?? 0.05,
    scale_invariant: line?.scale_invariant ?? false,
    points: line?.points?.map(normalizeVector3) ?? [],
    color: normalizeColorRGBA(line?.color),
    colors: normalizeColorRGBAs(line?.colors),
    indices: line?.indices?.map((idx) => idx ?? NaN) ?? [],
  };
}

function normalizeTriangleListPrimitive(
  triangles: PartialMessage<TriangleListPrimitive> | undefined,
): TriangleListPrimitive {
  return {
    pose: normalizePose(triangles?.pose),
    points: triangles?.points?.map(normalizeVector3) ?? [],
    color: normalizeColorRGBA(triangles?.color),
    colors: normalizeColorRGBAs(triangles?.colors),
    indices: triangles?.indices?.map((idx) => idx ?? NaN) ?? [],
  };
}

function normalizeTextPrimitive(text: PartialMessage<TextPrimitive> | undefined): TextPrimitive {
  return {
    pose: normalizePose(text?.pose),
    billboard: text?.billboard ?? true,
    font_size: text?.font_size ?? ((text?.scale_invariant ?? false) ? 16 : 0.25),
    scale_invariant: text?.scale_invariant ?? false,
    color: normalizeColorRGBA(text?.color),
    text: text?.text ?? "",
  };
}

function normalizeModelPrimitive(
  model: PartialMessage<ModelPrimitive> | undefined,
): ModelPrimitive {
  return {
    pose: normalizePose(model?.pose),
    scale: normalizeVector3(model?.scale),
    color: normalizeColorRGBA(model?.color),
    override_color: model?.override_color ?? false,
    url: model?.url ?? "",
    media_type: model?.media_type ?? "",
    data: normalizeByteArray(model?.data),
  };
}
