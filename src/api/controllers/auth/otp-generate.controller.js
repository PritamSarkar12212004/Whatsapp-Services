import { createLogger } from "../../../logs/logger.js";

const log = createLogger("otp");

import { ensureConnected } from "../../../integrations/whatsapp/connection.js";
import { hashing } from "../../../utils/encrypttion/hashing.util.js";
import { generateOtp } from "../../../utils/token/token.util.js";
import otpModel from "../../../models/otp/otp.model.js";
import whatsappModule from "../../../integrations/whatsapp/module.js";

const OTP_TTL_MS = 60 * 1000;
const GATEWAY_WAIT_MS = 15000;

const storeOtp = async (wpnumber, hashOtp, expiry) => {
  await otpModel.findOneAndUpdate(
    { wpnumber: wpnumber },
    { hashedOtp: hashOtp, expiresAt: expiry },
    { upsert: true, returnDocument: "after" },
  );
};

const generateOtpController = async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ message: "Enter valid WhatsApp number" });
  }

  // Wake the OTP gateway first. It reconnects by itself, so a request that
  // arrives while it is recovering can wait a few seconds instead of failing.
  const client = await ensureConnected({ timeoutMs: GATEWAY_WAIT_MS });
  if (!client) {
    log.error(
      "[OTP] WhatsApp gateway is not connected — refusing to claim delivery",
    );
    return res.status(503).json({
      success: false,
      message:
        "WhatsApp service is reconnecting. Please try again in a few seconds.",
    });
  }

  // Always issue a fresh OTP and store its hash BEFORE sending. The previous
  // code sent a new OTP when an unexpired one existed without updating the
  // hash, so that OTP could never be verified.
  const otp = generateOtp();
  const hashOtp = await hashing(otp);
  const expiry = new Date(Date.now() + OTP_TTL_MS);

  await storeOtp(phone, hashOtp, expiry);

  const result = await whatsappModule(client, phone, otp, "Verification");

  if (!result?.success) {
    return res.status(502).json({
      success: false,
      message: "Could not send OTP on WhatsApp. Please try again.",
    });
  }

  return res.status(200).json({
    success: true,
    message: "OTP sent to your WhatsApp",
  });
};

export default generateOtpController;
