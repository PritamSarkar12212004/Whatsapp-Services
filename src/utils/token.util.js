import jwt from "jsonwebtoken";
import crypto from "crypto";

/**
 * Generates a JWT token.
 * Supports both original signatures:
 *   - Auth/User service: tokenGenerator({ payload1, payload2, type }) → type "access"/"refresh"
 *   - OTP service:       tokenGenerator({ phone }) → 10m expiry
 */
export const tokenGenerator = (payload) => {
  // OTP-style payload: { phone: ... }
  if (payload.phone) {
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "10m" });
  }
  // Auth-style payload: { payload1, payload2, type }
  const { payload1, payload2, type } = payload;
  const expiresIn = type === "access" ? "10m" : "15d";
  return jwt.sign(
    { payload1, payload2, type },
    process.env.JWT_SECRET,
    { expiresIn },
  );
};

export const tokenVarify = ({ payload }) => {
  const status = jwt.verify(payload, process.env.JWT_SECRET);
  return status;
};

export const generateOtp = () =>
  crypto.randomInt(100000, 999999).toString();