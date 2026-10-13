/** Agent tool: unicity_create_public_group — create a public NIP-29 group chat. */

import { Type, type Static } from "typebox";
import type { GroupData } from "@unicitylabs/sphere-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { beginGroupOp, endGroupOp } from "../group-ops.js";
import { getSphereOrNull } from "../sphere.js";
import { sanctionGroup } from "./join-group.js";
import { errorMessage, errorResult, textResult, walletGroupChat } from "./result.js";

const Params = Type.Object({
  name: Type.String({ minLength: 1, description: "Group name" }),
  description: Type.Optional(Type.String({ description: "Group description" })),
});

export const createPublicGroupTool: AnyAgentTool = {
  name: "unicity_create_public_group",
  label: "Create Public Group",
  description:
    "Create a new public NIP-29 group chat that anyone can discover and join. " +
    "Quote the returned group id exactly when referring to the group. Owner only (enforced by the plugin).",
  parameters: Params,
  async execute(_toolCallId, rawParams) {
    const params = rawParams as Static<typeof Params>;
    const name = params.name.trim();
    if (!name) return errorResult("A group name is required.", "invalid_name");
    const wallet = walletGroupChat(getSphereOrNull());
    if ("unavailable" in wallet) return wallet.unavailable;
    const { sphere, groupChat } = wallet;
    let group: GroupData | null;
    let note = "";
    beginGroupOp(); // until the group is recorded as sanctioned (see sanctionGroup)
    try {
      group = await groupChat.createGroup({ name, description: params.description, visibility: "PUBLIC" });
      if (group) note = sanctionGroup(sphere, group.id);
    } catch (err) {
      return errorResult(`Failed to create the group: ${errorMessage(err)}`, "create_failed");
    } finally {
      endGroupOp();
    }
    if (!group) return errorResult("The group relay did not confirm creating the group.", "create_failed");
    return textResult(`Public group created: ${group.name} (id: ${group.id})${note}`, {
      groupId: group.id,
      name: group.name,
      visibility: "public",
    });
  },
};
