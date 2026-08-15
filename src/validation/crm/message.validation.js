import Joi from "joi";

const objectId = Joi.string().hex().length(24);

const sendMessageSchema = Joi.object({
  to: Joi.string().required().messages({
    "string.empty": "Recipient 'to' is required",
  }),
  template: Joi.string().required().messages({
    "string.empty": "Template is required",
  }),
  variables: Joi.object().default({}),
});

const validateSendMessage = (req, res, next) => {
  const { error } = sendMessageSchema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ message: error.details[0].message });
  next();
};

export { validateSendMessage, sendMessageSchema, objectId };
