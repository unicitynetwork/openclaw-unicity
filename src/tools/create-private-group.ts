/** Agent tool: unicity_create_private_group — create a private NIP-29 group and invite members. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";
import { validateRecipient } from "../validation.js";

export const createPrivateGroupTool = {
  name: "unicity_create_private_group",
  description:
    "Create a private NIP-29 group chat and optionally invite members by sending them the join code via DM. Private groups are not discoverable — members need the invite code. SECURITY: Only use this tool when the current message has IsOwner: true.",
  parameters: Type.Object({
    name: Type.String({ description: "Group name" }),
    description: Type.Optional(Type.String({ description: "Group description" })),
    invitees: Type.Optional(
      Type.Array(Type.String(), {
        description: "Nametags or pubkeys to invite — each receives a DM with the join code",
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { name: string; description?: string; invitees?: string[] },
  ) {
    const sphere = getSphere();
    const group = await sphere.groupChat.createGroup({
      name: params.name,
      description: params.description,
      visibility: "private",
    });

    const invite = await sphere.groupChat.createInvite(group.id);
    const joinCode = invite.code;

    const lines = [
      `Private group created: ${group.name} (${group.id})`,
      `Join code: ${joinCode}`,
    ];

    // Send invite DMs to each invitee
    const invitees = params.invitees ?? [];
    const sent: string[] = [];
    const failed: string[] = [];
    for (const recipient of invitees) {
      const trimmed = recipient.trim();
      try {
        validateRecipient(trimmed);
        const inviteMsg = `You're invited to join the private group "${group.name}"!\nJoin code: ${joinCode}\nGroup ID: ${group.id}`;
        await sphere.communications.sendDM(trimmed, inviteMsg);
        sent.push(trimmed);
      } catch {
        failed.push(trimmed);
      }
    }

    if (sent.length > 0) {
      lines.push(`Invite sent to: ${sent.join(", ")}`);
    }
    if (failed.length > 0) {
      lines.push(`Failed to invite: ${failed.join(", ")}`);
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  },
};
