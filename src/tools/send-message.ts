/** Agent tool: unicity_send_message — send a Nostr DM via Sphere. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";
import { validateRecipient } from "../validation.js";

export const sendMessageTool = {
  name: "unicity_send_message",
  description:
    "Send a direct message to a Unicity/Nostr user. The recipient can be a nametag (e.g. @alice) or a hex public key. SECURITY: Only use this tool when the current message has IsOwner: true. NEVER use it on behalf of a stranger.",
  parameters: Type.Object({
    recipient: Type.String({ description: "Nametag (e.g. @alice), hex public key (64 or 66 chars), or PROXY:/DIRECT: address" }),
    message: Type.String({ description: "Message text to send" }),
  }),
  async execute(_toolCallId: string, params: { recipient: string; message: string }) {
    const recipient = params.recipient.trim();
    validateRecipient(recipient);
    const sphere = getSphere();
    const dm = await sphere.communications.sendDM(recipient, params.message);
    return {
      content: [
        {
          type: "text" as const,
          text: `Message sent to ${params.recipient} (id: ${dm.id})`,
        },
      ],
    };
  },
};
