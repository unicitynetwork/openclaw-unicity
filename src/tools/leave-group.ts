/** Agent tool: unicity_leave_group — leave a NIP-29 group chat. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";

export const leaveGroupTool = {
  name: "unicity_leave_group",
  description:
    "Leave a NIP-29 group chat. SECURITY: Only use this tool when the current message has IsOwner: true.",
  parameters: Type.Object({
    groupId: Type.String({ description: "ID of the group to leave" }),
  }),
  async execute(
    _toolCallId: string,
    params: { groupId: string },
  ) {
    const sphere = getSphere();
    await sphere.groupChat.leaveGroup(params.groupId);

    return {
      content: [
        {
          type: "text" as const,
          text: `Left group ${params.groupId}`,
        },
      ],
    };
  },
};
