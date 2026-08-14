import tokenStore from "../services/tokenStore.service.js";
import tokenKey from "../config/key.constants.js";
import userProfileModel from "../models/userProfile.model.js";
import { tokenVarify, tokenGenerator } from "../utils/token.util.js";

const ACCESS_TOKEN_TTL = 600;
const REFRESH_TOKEN_TTL = 1296000;

const getAccessKey = (userId, deviceId) =>
  `${tokenKey.USER_ACCESS_KEY}${userId}:${deviceId}`;
const getRefreshKey = (userId, deviceId) =>
  `${tokenKey.USER_REFRESH_KEY}${userId}:${deviceId}`;

/**
 * Replaces the original Redis-based RedisTokenVarifucation middleware.
 * Same logic & response contract, but backed by MongoDB tokenStore (no Redis).
 */
const authTokenVerification = async (req, res, next) => {
  try {
    const { accessToken, refreshToken } = req.body;

    // 1. Try access token
    if (accessToken) {
      try {
        const decodeAccess = tokenVarify({ payload: accessToken });

        if (decodeAccess?.type === "access") {
          const { payload1: userId, payload2: deviceId } = decodeAccess;

          const storedToken = await tokenStore.get(getAccessKey(userId, deviceId));

          if (storedToken && storedToken === accessToken) {
            req.user = { userId, deviceId };
            return next();
          }
        }
      } catch (err) {
        console.warn("[Auth] Access token invalid:", err.message);
      }
    }

    // 2. Try refresh token
    if (refreshToken) {
      try {
        const decodeRefresh = tokenVarify({ payload: refreshToken });

        if (decodeRefresh?.type === "refresh") {
          const { payload1: userId, payload2: deviceId } = decodeRefresh;
          const user = await userProfileModel.findById(userId);

          if (!user) {
            return res.status(404).json({
              status: false,
              message: "User not found",
            });
          }

          if (user.deviceId !== deviceId) {
            return res.status(401).json({
              status: false,
              message: "Session expired, please login again",
              reason: "DEVICE_CHANGED",
            });
          }

          const storedRefresh = await tokenStore.get(
            getRefreshKey(userId, deviceId),
          );

          if (storedRefresh && storedRefresh === refreshToken) {
            const newAccessToken = tokenGenerator({
              payload1: userId,
              payload2: deviceId,
              type: "access",
            });

            await tokenStore.set(
              getAccessKey(userId, deviceId),
              newAccessToken,
              ACCESS_TOKEN_TTL,
            );

            await tokenStore.set(
              getRefreshKey(userId, deviceId),
              refreshToken,
              REFRESH_TOKEN_TTL,
            );

            req.newTokens = { accessToken: newAccessToken };
            req.accessTokenChanged = true;
            req.user = { userId, deviceId };
            return next();
          }
        }
      } catch (err) {
        console.warn("[Auth] Refresh token invalid:", err.message);
      }
    }

    return res.status(401).json({
      status: false,
      message: "Session expired, please login again",
      reason: "SESSION_EXPIRED",
    });
  } catch (error) {
    console.error("[Auth] Middleware error:", error);
    return res.status(500).json({
      status: false,
      message: "Internal server error",
    });
  }
};

export default authTokenVerification;