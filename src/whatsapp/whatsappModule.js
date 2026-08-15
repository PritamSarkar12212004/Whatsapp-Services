import { getSocket } from "./whatsappManager.js";

/**
 * Send an OTP message using the system-level WhatsApp connection.
 * Used by the OTP authentication flow.
 */
const whatsappModule = async (client, number, otp, content) => {
  try {
    if (!number || !otp) {
      console.error("Number and OTP are required");
      return;
    }

    if (!client) {
      console.error("WhatsApp client not connected");
      return;
    }

    let phoneNumber = number.toString().replace(/\D/g, "");
    if (phoneNumber.length === 10) phoneNumber = `91${phoneNumber}`;
    else if (phoneNumber.length !== 12) {
      console.error(`Invalid phone number: ${number}`);
      return;
    }

    const chatId = `${phoneNumber}@s.whatsapp.net`;

    if (!client.user) {
      console.error("WhatsApp client is not authenticated");
      return;
    }

    const result = await client.sendMessage(chatId, {
      text: ` ${content}  OTP is: *${otp}*`,
    });

    console.log(`OTP sent successfully via WhatsApp. Message ID: ${result.key.id}`);
  } catch (err) {
    console.error(err, { phone: number, otp });
  }
};

/**
 * Send a message using a specific user's WhatsApp session.
 * The userId determines which socket is used.
 */
export const sendUserMessage = async (userId, number, message) => {
  try {
    if (!userId || !number || !message) {
      console.error("userId, number, and message are required");
      return { success: false, error: "Missing required parameters" };
    }

    const client = getSocket(userId);

    if (!client) {
      console.error(`WhatsApp session not connected for user ${userId}`);
      return { success: false, error: "WhatsApp not connected" };
    }

    if (!client.user) {
      console.error(`WhatsApp session not authenticated for user ${userId}`);
      return { success: false, error: "WhatsApp not authenticated" };
    }

    let phoneNumber = number.toString().replace(/\D/g, "");
    if (phoneNumber.length === 10) phoneNumber = `91${phoneNumber}`;
    else if (phoneNumber.length !== 12) {
      console.error(`Invalid phone number: ${number}`);
      return { success: false, error: "Invalid phone number" };
    }

    const chatId = `${phoneNumber}@s.whatsapp.net`;

    const result = await client.sendMessage(chatId, { text: message });

    console.log(
      `Message sent via user ${userId}'s WhatsApp. Message ID: ${result.key.id}`,
    );
    return { success: true, messageId: result.key.id };
  } catch (err) {
    console.error(err, { userId, phone: number });
    return { success: false, error: err.message };
  }
};

export default whatsappModule;