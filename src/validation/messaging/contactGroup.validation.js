import Joi from "joi";

const objectId = Joi.string().hex().length(24);

const contactGroupSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required().messages({
    "string.empty": "Group name is required",
  }),
  description: Joi.string().trim().max(500).allow(""),
  contacts: Joi.array().items(objectId),
});

const validateContactGroup = (req, res, next) => {
  const { error } = contactGroupSchema.validate(req.body, {
    abortEarly: false,
  });
  if (error) return res.status(400).json({ message: error.details[0].message });
  next();
};

export { validateContactGroup, contactGroupSchema };
