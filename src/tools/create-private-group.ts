/** Agent tool: unicity_create_private_group — create a private NIP-29 group and DM the join code to invitees. */

import { Type, type Static } from "typebox";
import type { GroupData } from "@unicitylabs/sphere-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { beginGroupOp, endGroupOp } from "../group-ops.js";
import { getSphereOrNull } from "../sphere.js";
import { validateRecipient } from "../validation.js";
import { sanctionGroup } from "./join-group.js";
import { errorMessage, errorResult, textResult, walletGroupChat } from "./result.js";

const Params = Type.Object({
  name: Type.String({ minLength: 1, description: "Group name" }),
  description: Type.Optional(Type.String({ description: "Group description" })),
  invitees: Type.Optional(
    Type.Array(Type.String(), {
      description: "@nametags or public keys to invite; each receives a DM with the join code",
    }),
  ),
});

export const createPrivateGroupTool: AnyAgentTool = {
  name: "unicity_create_private_group",
  label: "Create Private Group",
  description:
    "Create a private NIP-29 group chat and optionally DM the join code to invitees. " +
    "Private groups are not discoverable; members need the join code. Owner only (enforced by the plugin).",
  parameters: Params,
  async execute(_toolCallId, rawParams) {
    const params = rawParams as Static<typeof Params>;
    const name = params.name.trim();
    if (!name) return errorResult("A group name is required.", "invalid_name");
    const invitees = (params.invitees ?? []).map((r) => r.trim()).filter(Boolean);
    for (const invitee of invitees) {
      try {
        validateRecipient(invitee);
      } catch (err) {
        return errorResult(`${errorMessage(err)} No group was created.`, "invalid_recipient");
      }
    }
    const wallet = walletGroupChat(getSphereOrNull());
    if ("unavailable" in wallet) return wallet.unavailable;
    const { sphere, groupChat } = wallet;

    let group: GroupData | null;
    let sanctionNote = "";
    beginGroupOp(); // until the group is recorded as sanctioned (see sanctionGroup)
    try {
      group = await groupChat.createGroup({ name, description: params.description, visibility: "PRIVATE" });
      if (group) sanctionNote = sanctionGroup(sphere, group.id);
    } catch (err) {
      return errorResult(`Failed to create the group: ${errorMessage(err)}`, "create_failed");
    } finally {
      endGroupOp();
    }
    if (!group) return errorResult("The group relay did not confirm creating the group.", "create_failed");

    const created = `Private group created: ${group.name} (id: ${group.id})`;
    const joinCode = await groupChat.createInvite(group.id).catch(() => null);
    if (!joinCode) {
      return errorResult(
        `${created}, but no join code could be generated, so nobody was invited. Do not create the group again.${sanctionNote}`,
        "invite_failed",
        { groupId: group.id },
      );
    }

    const invited: string[] = [];
    const failed: string[] = [];
    const inviteText = `You're invited to join the private group "${group.name}"!\nJoin code: ${joinCode}\nGroup ID: ${group.id}`;
    for (const recipient of invitees) {
      try {
        await sphere.communications.sendDM(recipient, inviteText);
        invited.push(recipient);
      } catch {
        failed.push(recipient);
      }
    }

    const lines = [created, `Join code: ${joinCode}`];
    if (invited.length > 0) lines.push(`Invite sent to: ${invited.join(", ")}`);
    if (failed.length > 0) lines.push(`Failed to invite: ${failed.join(", ")}`);
    return textResult(lines.join("\n") + sanctionNote, { groupId: group.id, name: group.name, visibility: "private", invited, failed });
  },
};
