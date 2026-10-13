/** Agent tool: unicity_leave_group — leave a NIP-29 group chat. */

import { Type, type Static } from "typebox";
import type { Sphere } from "@unicitylabs/sphere-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { getSphereOrNull } from "../sphere.js";
import { revokeGroup } from "../storage.js";
import { sanitizeOneLine } from "../text.js";
import { isGroupId } from "../validation.js";
import { errorMessage, errorResult, textResult, walletGroupChat } from "./result.js";

/**
 * Withdraws the owner's approval of a group the wallet left, so a group admin who adds this key back later gets it
 * ignored again (and the owner told again). Never throws, so a completed leave is never reported as failed; returns a
 * note for the tool result when recording failed.
 */
function unsanctionGroup(sphere: Sphere, groupId: string): string {
  try {
    const walletKey = sphere.identity?.chainPubkey;
    if (!walletKey) throw new Error("the wallet identity is not available");
    revokeGroup(walletKey, groupId);
    return "";
  } catch (err) {
    return `\nWarning: could not withdraw the group's approval (${errorMessage(err)}); if a group admin adds me back, I will take part there again without asking first.`;
  }
}

const Params = Type.Object({
  groupId: Type.String({ description: "ID of the group to leave" }),
});

export const leaveGroupTool: AnyAgentTool = {
  name: "unicity_leave_group",
  label: "Leave Group",
  description: "Leave a NIP-29 group chat. Owner only (enforced by the plugin).",
  parameters: Params,
  resultContentSource: "network",
  async execute(_toolCallId, rawParams) {
    const params = rawParams as Static<typeof Params>;
    const groupId = params.groupId.trim();
    if (!isGroupId(groupId)) return errorResult(`Invalid group id "${groupId}".`, "invalid_group_id");
    const wallet = walletGroupChat(getSphereOrNull());
    if ("unavailable" in wallet) return wallet.unavailable;
    const { sphere, groupChat } = wallet;
    // Leaving drops the group from local state, so read its name first.
    const name = sanitizeOneLine(groupChat.getGroup(groupId)?.name, 64);
    try {
      if (!(await groupChat.leaveGroup(groupId))) {
        return errorResult(`Could not leave group ${groupId}: the relay did not accept the request.`, "leave_failed");
      }
    } catch (err) {
      return errorResult(`Failed to leave group ${groupId}: ${errorMessage(err)}`, "leave_failed");
    }
    const note = unsanctionGroup(sphere, groupId);
    return textResult(`Left group ${name ? `"${name}" ` : ""}(id: ${groupId})${note}`, { groupId });
  },
};
