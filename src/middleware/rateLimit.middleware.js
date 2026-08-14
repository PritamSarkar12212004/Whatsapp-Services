import rateLimit from "express-rate-limit";

const rateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many requests. Please try again later.",
  },
  handler: (req, res) => {
    console.warn(
      `[${new Date().toISOString()}] RATE LIMIT HIT: ${req.method} ${req.originalUrl}`,
    );

    res.status(429).json({
      success: false,
      error: "Too many requests. Please try again later.",
    });
  },
});

export default rateLimiter;