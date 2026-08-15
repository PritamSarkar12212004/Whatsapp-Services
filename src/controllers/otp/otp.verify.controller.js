import { decryptHashing } from "../../utils/encrypttion/hashing.util.js";
import otpModel from "../../models/otp/otp.model.js";
import userProfileModel from "../../models/user/userProfile.model.js";
import { generateToken } from "../../utils/token/jwt.util.js";

const verifyOtpController = async (req, res) => {
  try {
    const { otp, phone } = req.body;

    if (!otp || !phone) {
      return res.status(400).json({
        status: "error",
        message: "OTP and Phone number are required",
      });
    }

    const otpRecord = await otpModel.findOne({
      wpnumber: phone,
    });

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

    const isValid = await decryptHashing(
      otpRecord.hashedOtp,
      otp
    );

    if (!isValid) {
      return res.status(401).json({
        status: "error",
        message: "Invalid OTP. Please try again.",
      });
    }

    const existingUser = await userProfileModel.findOne({
      wpnumber: phone,
    });

    const token = generateToken({
      wpnumber: phone,
    });

    const response = {
      status: "success",
      message: "OTP verified successfully",
      token,
      isExistingUser: !!existingUser,
      data: existingUser
        ? {
          _id: existingUser._id,
          wpnumber: existingUser.wpnumber,
          fullName: existingUser.fullName,
          gender: existingUser.gender,
          age: existingUser.age,
          profilePic: existingUser.profilePic,
        }
        : null,
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error("Error verifying OTP:", err);

    return res.status(500).json({
      status: "error",
      message: "Internal server error during OTP verification",
    });
  }
};

export default verifyOtpController;