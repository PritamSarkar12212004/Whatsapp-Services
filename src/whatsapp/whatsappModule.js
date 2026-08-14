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

export default whatsappModule;