import joi from "joi";

// Phone number-only validation (for generate-otp)
const phoneNumberSchema = joi.object({
  phone: joi
    .string()
    .pattern(/^[0-9]{10}$/)
    .required()
    .messages({
      "string.empty": "Phone number is required",
      "string.pattern.base": "Phone number must be 10 digits",
    }),
});

export const phoneNumber = (req, res, next) => {
  const { error } = phoneNumberSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });
  next();
};

// OTP + phone validation (for verify-otp)
const otpSchema = joi.object({
  otp: joi
    .string()
    .pattern(/^[0-9]{6}$/)
    .required()
    .messages({
      "string.empty": "OTP is required",
      "string.pattern.base": "OTP must be 6 digits",
    }),
  phone: joi
    .string()
    .pattern(/^[0-9]{10}$/)
    .required()
    .messages({
      "string.empty": "Phone number is required",
      "string.pattern.base": "Phone number must be 10 digits",
    }),
});

export const otpValidation = (req, res, next) => {
  const { error } = otpSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ message: error.details[0].message });
  }
  next();
};