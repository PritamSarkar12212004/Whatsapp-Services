import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "whatsapp-services-secret-key";

/**
 * Generate a JWT token that NEVER expires.
 * By omitting the `expiresIn` option, the token has no expiration time.
 */
export const generateToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET);
};

/**
 * Verify a JWT token and return its decoded payload.
 */
export const verifyToken = (token) => {
  return jwt.verify(token, JWT_SECRET);
};