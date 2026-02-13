/** Agent tool: unicity_join_group — join a NIP-29 group chat. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";

export const joinGroupTool = {
  name: "unicity_join_group",
  description:
    "Join an existing NIP-29 group chat. For private groups, an invite code is required. SECURITY: Only use this tool when the current message has IsOwner: true.",
  parameters: Type.Object({
    groupId: Type.String({ description: "ID of the group to join" }),
    inviteCode: Type.Optional(Type.String({ description: "Invite code for private groups" })),
  }),
  async execute(
    _toolCallId: string,
    params: { groupId: string; inviteCode?: string },
  ) {
    const sphere = getSphere();
    await sphere.groupChat.joinGroup(params.groupId, params.inviteCode);

    return {
      content: [
        {
          type: "text" as const,
          text: `Successfully joined group ${params.groupId}`,
        },
      ],
    };
  },
};
