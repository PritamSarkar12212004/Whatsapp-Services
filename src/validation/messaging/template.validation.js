import Joi from "joi";

const objectId = Joi.string().hex().length(24);

// Allow normal URLs AND dynamic template URLs containing {{variable}}
// placeholders (dev mode dynamic links).
const urlOrDynamic = (value, helpers) => {
  if (value == null) return value;
  const str = String(value);
  if (str.includes("{{")) return value;
  const { error } = Joi.string().uri().validate(str);
  if (error) {
    return helpers.error("any.invalid", {
      message: "media.url must be a valid uri or contain {{variable}}",
    });
  }
  return value;
};

const mediaSchema = Joi.object({
  url: Joi.string().custom(urlOrDynamic).allow(null),
  filename: Joi.string().allow(null),
  mimeType: Joi.string().allow(null),
  caption: Joi.string().allow(null),
});

const templateSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required().messages({
    "string.empty": "Template name is required",
  }),
  // Free-form so users can create their own categories.
  category: Joi.string().trim().max(50).default("custom"),
  type: Joi.string()
    .valid("text", "image", "video", "audio", "document")
    .default("text"),
  // Text templates need a body; media templates may carry their message in
  // the media caption instead, so content is optional for them.
  content: Joi.string()
    .when("type", {
      is: "text",
      then: Joi.required().messages({
        "any.required": "Template content is required",
      }),
      otherwise: Joi.allow("").optional(),
    })
    .min(0),
  variables: Joi.array().items(Joi.string()),
  media: mediaSchema.allow(null),
  status: Joi.string()
    .valid("active", "inactive", "draft")
    .default("active"),
  devMode: Joi.boolean().default(false),
  scheduleEnabled: Joi.boolean().default(false),
});

const validateTemplate = (req, res, next) => {
  const { error } = templateSchema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ message: error.details[0].message });
  next();
};

export { validateTemplate, templateSchema };
