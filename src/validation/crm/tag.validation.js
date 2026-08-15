import Joi from "joi";

const tagSchema = Joi.object({
  name: Joi.string().trim().min(1).max(50).required().messages({
    "string.empty": "Tag name is required",
  }),
  color: Joi.string().trim().pattern(/^#([0-9a-fA-F]{3}){1,2}$/).messages({
    "string.pattern.base": "Color must be a valid hex color",
  }),
});

const validateTag = (req, res, next) => {
  const { error } = tagSchema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ message: error.details[0].message });
  next();
};

export { validateTag, tagSchema };
