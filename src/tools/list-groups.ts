/** Agent tool: unicity_list_groups — list NIP-29 group chats. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";

export const listGroupsTool = {
  name: "unicity_list_groups",
  description:
    "List NIP-29 group chats. Use scope 'joined' for groups you belong to, or 'available' to discover public groups.",
  parameters: Type.Object({
    scope: Type.Optional(
      Type.Union([Type.Literal("joined"), Type.Literal("available")], {
        description: "Which groups to list (default: joined)",
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { scope?: "joined" | "available" },
  ) {
    const sphere = getSphere();
    const scope = params.scope ?? "joined";

    const groups = scope === "available"
      ? await sphere.groupChat.fetchAvailableGroups()
      : sphere.groupChat.getGroups();

    if (groups.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: scope === "available"
              ? "No available groups found."
              : "Not a member of any groups.",
          },
        ],
      };
    }

    const lines = groups.map((g: { id: string; name: string; visibility?: string; memberCount?: number; unreadCount?: number }) => {
      const parts = [
        g.id,
        g.name,
        g.visibility ?? "public",
        g.memberCount != null ? `${g.memberCount} members` : null,
        g.unreadCount != null && g.unreadCount > 0 ? `${g.unreadCount} unread` : null,
      ].filter(Boolean);
      return parts.join(" | ");
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `${groups.length} group${groups.length !== 1 ? "s" : ""}:\n${lines.join("\n")}`,
        },
      ],
    };
  },
};
