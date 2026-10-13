/** Agent tool: unicity_join_group — join a NIP-29 group chat. */

import { Type, type Static } from "typebox";
import type { Sphere } from "@unicitylabs/sphere-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { beginGroupOp, endGroupOp } from "../group-ops.js";
import { getSphereOrNull } from "../sphere.js";
import { approveGroup } from "../storage.js";
import { sanitizeOneLine } from "../text.js";
import { isGroupId } from "../validation.js";
import { errorMessage, errorResult, textResult, walletGroupChat } from "./result.js";

/**
 * Records a group the owner joined or created as sanctioned: the channel ignores groups it was not (e.g. ones a group
 * admin added the agent to). Never throws, so a created group is never reported as failed; returns a note for the
 * tool result when recording failed.
 *
 * Callers mark the join/create as a group operation in flight (beginGroupOp) until this has run: the SDK lists the
 * group, and the relay streams its backlog, before joinGroup/createGroup resolve, and the channel waits for in-flight
 * operations before telling the owner about a group it is in without approval.
 */
export function sanctionGroup(sphere: Sphere, groupId: string): string {
  try {
    const walletKey = sphere.identity?.chainPubkey;
    if (!walletKey) throw new Error("the wallet identity is not available");
    approveGroup(walletKey, groupId);
    return "";
  } catch (err) {
    return `\nWarning: could not record the group as approved (${errorMessage(err)}); its messages may be ignored until it is joined again.`;
  }
}

const Params = Type.Object({
  groupId: Type.String({ description: "ID of the group to join" }),
  inviteCode: Type.Optional(Type.String({ description: "Join code (required for private groups)" })),
});

export const joinGroupTool: AnyAgentTool = {
  name: "unicity_join_group",
  label: "Join Group",
  description:
    "Join an existing NIP-29 group chat. Private groups need a join code. Owner only (enforced by the plugin).",
  parameters: Params,
  resultContentSource: "network",
  async execute(_toolCallId, rawParams) {
    const params = rawParams as Static<typeof Params>;
    const groupId = params.groupId.trim();
    if (!isGroupId(groupId)) return errorResult(`Invalid group id "${groupId}".`, "invalid_group_id");
    const inviteCode = params.inviteCode?.trim() || undefined;
    const wallet = walletGroupChat(getSphereOrNull());
    if ("unavailable" in wallet) return wallet.unavailable;
    const { sphere, groupChat } = wallet;
    let note: string;
    beginGroupOp(); // until the group is recorded as sanctioned (see sanctionGroup)
    try {
      if (!(await groupChat.joinGroup(groupId, inviteCode))) {
        return errorResult(
          `Could not join group ${groupId}: it was not found, needs a (valid) join code, or the relay refused.`,
          "join_failed",
        );
      }
      note = sanctionGroup(sphere, groupId);
    } catch (err) {
      return errorResult(`Failed to join group ${groupId}: ${errorMessage(err)}`, "join_failed");
    } finally {
      endGroupOp();
    }
    const name = sanitizeOneLine(groupChat.getGroup(groupId)?.name, 64);
    return textResult(`Joined group ${name ? `"${name}" ` : ""}(id: ${groupId})${note}`, { groupId });
  },
};
