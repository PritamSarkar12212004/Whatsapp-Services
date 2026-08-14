const requestInfo = (req, res, next) => {
  console.log(
    `[REQUEST] ${req.method} ${req.originalUrl} - IP: ${req.ip || req.socket?.remoteAddress || "unknown"}`,
  );
  next();
};

export default requestInfo;