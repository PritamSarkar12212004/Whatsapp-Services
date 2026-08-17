import Joi from "joi";

const objectId = Joi.string().hex().length(24);

const phonePattern = /^[0-9]{10,15}$/;

const contactSchema = Joi.object({
  phoneNumber: Joi.string().pattern(phonePattern).required().messages({
    "string.empty": "Phone number is required",
    "string.pattern.base": "Phone number must be 10-15 digits",
  }),
  name: Joi.string().trim().max(100).allow(null),
  pushName: Joi.string().trim().max(100).allow(null),
  profilePicture: Joi.string().uri().allow(null),
  isSavedContact: Joi.boolean(),
  isUnknown: Joi.boolean(),
  isBusiness: Joi.boolean(),
  tags: Joi.array().items(objectId),
  // customGroups accepts ObjectIds OR group names (names are auto-created
  // and resolved by contact.service createContact).
  customGroups: Joi.array().items(
    Joi.alternatives().try(objectId, Joi.string().trim().max(100))
  ),
  customFields: Joi.array().items(
    Joi.object({
      key: Joi.string().required(),
      value: Joi.string().allow(""),
    }),
  ),
  language: Joi.string().trim().max(20).allow(null),
  city: Joi.string().trim().max(100).allow(null),
  state: Joi.string().trim().max(100).allow(null),
  isBlocked: Joi.boolean(),
  isOptedOut: Joi.boolean(),
  lastMessageAt: Joi.date().allow(null),
  lastSeenAt: Joi.date().allow(null),
});

const validateContact = (req, res, next) => {
  const { error } = contactSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({ message: error.details[0].message });
  }
  next();
};

export { validateContact, contactSchema };
