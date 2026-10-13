/** Agent tool: unicity_send_message — send an encrypted DM via Sphere. */

import { Type, type Static } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { getSphereOrNull } from "../sphere.js";
import { validateRecipient } from "../validation.js";
import { errorMessage, errorResult, textResult, walletNotReadyResult } from "./result.js";

const Params = Type.Object({
  recipient: Type.String({
    description: "@nametag, 64-hex public key, 66-hex chain public key (02/03…) or DIRECT:// address",
  }),
  message: Type.String({ minLength: 1, description: "Message text to send" }),
});

export const sendMessageTool: AnyAgentTool = {
  name: "unicity_send_message",
  label: "Send Message",
  description:
    "Send an encrypted direct message to a Unicity user by @nametag or public key. " +
    "Your normal reply already reaches the current sender; use this only to message someone else. " +
    "Owner only (enforced by the plugin).",
  parameters: Params,
  async execute(_toolCallId, rawParams) {
    const params = rawParams as Static<typeof Params>;
    const recipient = params.recipient.trim();
    try {
      validateRecipient(recipient);
    } catch (err) {
      return errorResult(errorMessage(err), "invalid_recipient");
    }
    const sphere = getSphereOrNull();
    if (!sphere) return walletNotReadyResult();
    try {
      const dm = await sphere.communications.sendDM(recipient, params.message);
      return textResult(`Message sent to ${recipient} (id: ${dm.id})`, { recipient, messageId: dm.id });
    } catch (err) {
      return errorResult(`Failed to send the message to ${recipient}: ${errorMessage(err)}`, "send_failed");
    }
  },
};
