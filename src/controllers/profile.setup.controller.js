import jwt from "jsonwebtoken";
import userProfileModel from "../models/userProfile.model.js";
import tokenStore from "../services/tokenStore.service.js";
import tokenKey from "../config/key.constants.js";
import { tokenGenerator } from "../utils/token.util.js";

const profileSetupController = async (req, res) => {
  try {
    const { fullName, gender, age, profilePic, token, deviceId } = req.body;

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const phone = decoded.phone;

    // Replaces Redis: `otp_temp_token:${phone}` now stored in MongoDB (tokenStore)
    const redisKey = `${tokenKey.OTP_TEMP_TOKEN}:${phone}`;
    const storedToken = await tokenStore.get(redisKey);

    if (!storedToken || storedToken !== token) {
      return res.status(403).json({
        message: "Invalid or expired OTP session Relogin Account",
      });
    }
    const existingUser = await userProfileModel.findOne({
      wpnumber: phone,
    });
    if (existingUser) {
      return res.status(409).json({
        message: "Profile already exists",
      });
    }

    const user = await userProfileModel.create({
      wpnumber: phone,
      fullName,
      gender,
      age,
      profilePic,
      deviceId,
    });
    const accessToken = tokenGenerator({
      payload1: user._id,
      payload2: deviceId,
      type: "access",
    });
    const refreshToken = tokenGenerator({
      payload1: user._id,
      payload2: deviceId,
      type: "refresh",
    });

    const responseData = {
      wpnumber: user.wpnumber,
      fullName: user.fullName,
      gender: user.gender,
      age: user.age,
      profilePic: user.profilePic,
      refreshToken: refreshToken,
      accessToken: accessToken,
      _id: user._id,
    };

    // Replaces Redis DEL + two SETs with MongoDB upserts + TTL
    await tokenStore.del(redisKey);

    await tokenStore.set(
      `${tokenKey.USER_ACCESS_KEY}${user._id}:${deviceId}`,
      accessToken,
      600,
    );
    await tokenStore.set(
      `${tokenKey.USER_REFRESH_KEY}${user._id}:${deviceId}`,
      refreshToken,
      1296000,
    );

    return res.status(201).json({
      message: "Profile setup successful",
      data: responseData,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

export default profileSetupController;