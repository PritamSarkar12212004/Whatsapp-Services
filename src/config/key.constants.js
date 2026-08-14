/**
 * Token key prefixes.
 * Preserves the exact Redis key names used by the original microservices.
 */
const tokenKey = {
  OTP_TEMP_TOKEN: "otp_temp_token",
  USER_ACCESS_KEY: "USER_ACCESS:",
  USER_REFRESH_KEY: "USER_REFRESH:",
};

export default tokenKey;