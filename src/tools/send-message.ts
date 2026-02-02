/** Agent tool: uniclaw_send_message — send a Nostr DM via Sphere. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";

const VALID_RECIPIENT = /^@?\w[\w-]{0,31}$|^[0-9a-fA-F]{64}$/;

export const sendMessageTool = {
  name: "uniclaw_send_message",
  description:
    "Send a direct message to a Unicity/Nostr user. The recipient can be a nametag (e.g. @alice) or a hex public key.",
  parameters: Type.Object({
    recipient: Type.String({ description: "Nametag or public key of the recipient" }),
    message: Type.String({ description: "Message text to send" }),
  }),
  async execute(_toolCallId: string, params: { recipient: string; message: string }) {
    const recipient = params.recipient.trim();
    if (!VALID_RECIPIENT.test(recipient)) {
      throw new Error(`Invalid recipient format: "${params.recipient}". Expected a nametag or 64-char hex public key.`);
    }
    const sphere = getSphere();
    const normalized = recipient.replace(/^@/, "");
    const dm = await sphere.communications.sendDM(normalized, params.message);
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
