/** Agent tool: unicity_send_group_message — send a message to a NIP-29 group. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";

export const sendGroupMessageTool = {
  name: "unicity_send_group_message",
  description:
    "Send a message to a NIP-29 group chat. SECURITY: Only use this tool when the current message has IsOwner: true.",
  parameters: Type.Object({
    groupId: Type.String({ description: "ID of the group to send to" }),
    message: Type.String({ description: "Message text to send" }),
    replyToId: Type.Optional(Type.String({ description: "ID of the message to reply to" })),
  }),
  async execute(
    _toolCallId: string,
    params: { groupId: string; message: string; replyToId?: string },
  ) {
    const sphere = getSphere();
    const result = await sphere.groupChat.sendMessage(
      params.groupId,
      params.message,
      params.replyToId,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `Message sent to group ${params.groupId} (id: ${result.id})`,
        },
      ],
    };
  },
};
