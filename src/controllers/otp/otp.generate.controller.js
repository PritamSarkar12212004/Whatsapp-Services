import { getClient } from "../../whatsapp/whatsappConnection.js";
import { hashing } from "../../utils/encrypttion/hashing.util.js";
import { generateOtp } from "../../utils/token/token.util.js";
import otpModel from "../../models/otp/otp.model.js";
import whatsappModule from "../../whatsapp/whatsappModule.js";

const storeOtp = async (wpnumber, hashOtp, expiry) => {
  await otpModel.findOneAndUpdate(
    { wpnumber: wpnumber },
    { hashedOtp: hashOtp, expiresAt: expiry },
    { upsert: true, new: true },
  );
};

const generateOtpController = async (req, res) => {
  const client = getClient();
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ message: "Enter valid WhatsApp number" });
  }
  const otp = await generateOtp();

  let otpRecord = await otpModel.findOne({ wpnumber: phone });

  if (otpRecord && otpRecord.expiresAt > new Date()) {
    await whatsappModule(client, phone, otp, "Verification");
    return res.status(200).json({
      message: "OTP already sent, check WhatsApp",
    });
  }

  const hashOtp = await hashing(otp);
  const expiry = new Date(Date.now() + 1 * 60 * 1000);

  await storeOtp(phone, hashOtp, expiry);
  await whatsappModule(client, phone, otp, "Verification");

  return res.status(200).json({
    message: "OTP sent to your WhatsApp",
  });
};

export default generateOtpController;