import Joi from "joi";

const profileSetupSchema = Joi.object({
  wpnumber: Joi.string()
    .pattern(/^[0-9]{10}$/)
    .required()
    .messages({
      "string.empty": "Phone number is required",
      "string.pattern.base": "Phone number must be exactly 10 digits",
    }),

  fullName: Joi.string().trim().min(1).max(50).required().messages({
    "string.empty": "Full Name is required",
    "string.min": "Full Name must be at least 3 characters",
    "string.max": "Full Name must not exceed 50 characters",
  }),

  gender: Joi.string().valid("male", "female", "other").required().messages({
    "any.only": "Gender must be male, female, or other",
    "string.empty": "Gender is required",
  }),

  age: Joi.number().integer().min(1).max(100).required().messages({
    "number.base": "Age must be a number",
    "number.min": "Age must be at least 1",
    "number.max": "Age cannot be more than 100",
  }),

  token: Joi.string().required().messages({
    "string.empty": "token is required",
  }),
});

const profileSetupValidation = (req, res, next) => {
  const { error } = profileSetupSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });
  next();
};

export default profileSetupValidation;