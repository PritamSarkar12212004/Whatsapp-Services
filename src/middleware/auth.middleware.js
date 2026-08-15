import { verifyToken } from "../utils/token/jwt.util.js";


const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        status: "error",
        message: "No token provided. Please login first.",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = verifyToken(token);

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      status: "error",
      message: "Invalid or expired token. Please login again.",
    });
  }
};

export default authMiddleware;