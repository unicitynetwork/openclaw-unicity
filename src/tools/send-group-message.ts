/** Agent tool: unicity_send_group_message — send a message to a joined NIP-29 group. */

import { Type, type Static } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { getSphereOrNull } from "../sphere.js";
import { isGroupId } from "../validation.js";
import { errorMessage, errorResult, textResult, walletGroupChat } from "./result.js";

const Params = Type.Object({
  groupId: Type.String({ description: "ID of a joined group" }),
  message: Type.String({ minLength: 1, description: "Message text to send" }),
  replyToId: Type.Optional(Type.String({ description: "ID of the group message to reply to" })),
});

export const sendGroupMessageTool: AnyAgentTool = {
  name: "unicity_send_group_message",
  label: "Send Group Message",
  description:
    "Send a message to a NIP-29 group chat you have joined. Your normal reply already reaches the group you are " +
    "chatting in; use this only for another group. Owner only (enforced by the plugin).",
  parameters: Params,
  async execute(_toolCallId, rawParams) {
    const params = rawParams as Static<typeof Params>;
    const groupId = params.groupId.trim();
    if (!isGroupId(groupId)) return errorResult(`Invalid group id "${groupId}".`, "invalid_group_id");
    const wallet = walletGroupChat(getSphereOrNull());
    if ("unavailable" in wallet) return wallet.unavailable;
    const { groupChat } = wallet;
    try {
      const sent = await groupChat.sendMessage(groupId, params.message, params.replyToId?.trim() || undefined);
      if (!sent) {
        return errorResult(
          `Message not sent: not a member of group ${groupId}, or the relay rejected it.`,
          "send_failed",
        );
      }
      return textResult(`Message sent to group ${groupId}${sent.id ? ` (id: ${sent.id})` : ""}`, {
        groupId,
        messageId: sent.id,
      });
    } catch (err) {
      return errorResult(`Failed to send the message to group ${groupId}: ${errorMessage(err)}`, "send_failed");
    }
  },
};
