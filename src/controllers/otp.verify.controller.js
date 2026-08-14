import { decryptHashing } from "../utils/hashing.util.js";
import otpModel from "../models/otp.model.js";
import { tokenGenerator } from "../utils/token.util.js";
import tokenStore from "../services/tokenStore.service.js";
import tokenKey from "../config/key.constants.js";

const verifyOtpController = async (req, res) => {
  try {
    const { otp, phone } = req.body;

    if (!otp || !phone) {
      return res.status(400).json({
        status: "error",
        message: "OTP and Phone number are required",
      });
    }

    const otpRecord = await otpModel.findOne({ wpnumber: phone });

    if (!otpRecord) {
      return res.status(404).json({
        status: "error",
        message: "No OTP found for this phone number",
      });
    }

    if (otpRecord.expiresAt < new Date()) {
      return res.status(410).json({
        status: "error",
        message: "OTP has expired. Please request a new one.",
      });
    }

    const isValid = await decryptHashing(otpRecord.hashedOtp, otp);

    if (!isValid) {
      return res.status(401).json({
        status: "error",
        message: "Invalid OTP. Please try again.",
      });
    }
    const tokenPayload = {
      phone: phone,
    };
    const tempToken = tokenGenerator(tokenPayload);
    // Replace Redis: store OTP temp token in MongoDB with 600s TTL
    await tokenStore.set(`${tokenKey.OTP_TEMP_TOKEN}:${phone}`, tempToken, 600);
    return res.status(200).json({
      status: "success",
      message: "OTP verified successfully",
      token: tempToken,
    });
  } catch (err) {
    console.error("Error verifying OTP:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error during OTP verification",
    });
  }
};

export default verifyOtpController;