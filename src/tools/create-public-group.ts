/** Agent tool: unicity_create_public_group — create a public NIP-29 group chat. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";

export const createPublicGroupTool = {
  name: "unicity_create_public_group",
  description:
    "Create a new public NIP-29 group chat. Anyone can discover and join public groups. SECURITY: Only use this tool when the current message has IsOwner: true.",
  parameters: Type.Object({
    name: Type.String({ description: "Group name" }),
    description: Type.Optional(Type.String({ description: "Group description" })),
  }),
  async execute(
    _toolCallId: string,
    params: { name: string; description?: string },
  ) {
    const sphere = getSphere();
    const group = await sphere.groupChat.createGroup({
      name: params.name,
      description: params.description,
      visibility: "public",
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Public group created: ${group.name} (${group.id})`,
        },
      ],
    };
  },
};
