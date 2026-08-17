import Joi from "joi";

const objectId = Joi.string().hex().length(24);

const mediaSchema = Joi.object({
  url: Joi.string().required(),
  filename: Joi.string().allow(null),
  mimeType: Joi.string().allow(null),
  caption: Joi.string().allow(null),
});

const phoneOrArray = Joi.alternatives()
  .try(Joi.string(), Joi.array().items(Joi.string()))
  .required()
  .messages({
    "any.required": "Recipient 'to' is required",
    "alternatives.match": "Recipient 'to' must be a phone number or an array of phone numbers",
  });

const sendMessageSchema = Joi.object({
  to: phoneOrArray,
  template: Joi.string().required().messages({
    "string.empty": "Template is required",
  }),
  variables: Joi.object().default({}),
  // Optional media override — when omitted, the template's own media is used.
  media: mediaSchema.allow(null),
  // Optional schedule — ISO date (24h format). When set, the message is sent
  // only after that time.
  scheduledAt: Joi.date().allow(null),
});

const validateSendMessage = (req, res, next) => {
  const { error } = sendMessageSchema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ message: error.details[0].message });
  next();
};

export { validateSendMessage, sendMessageSchema, objectId };
