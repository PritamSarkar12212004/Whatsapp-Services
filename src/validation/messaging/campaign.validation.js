import Joi from "joi";

const objectId = Joi.string().hex().length(24);

const audienceSchema = Joi.object({
  groups: Joi.array().items(objectId),
  tags: Joi.array().items(objectId),
  contacts: Joi.array().items(objectId),
  excludedContacts: Joi.array().items(objectId),
});

const campaignSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required().messages({
    "string.empty": "Campaign name is required",
  }),
  template: objectId.required().messages({
    "any.required": "Template id is required",
  }),
  audience: audienceSchema.required(),
  variables: Joi.object(),
  scheduledAt: Joi.date().allow(null),
  sendLimit: Joi.number().integer().min(1).allow(null),
});

const validateCampaign = (req, res, next) => {
  const { error } = campaignSchema.validate(req.body, {
    abortEarly: false,
  });
  if (error) return res.status(400).json({ message: error.details[0].message });
  next();
};

export { validateCampaign, campaignSchema };
