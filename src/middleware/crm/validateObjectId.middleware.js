/**
 * Middleware: validate that specified route params are valid MongoDB ObjectIds.
 *
 * Usage: router.get("/contacts/:id", validateObjectId("id"), handler)
 *        router.get("/contact-groups/:id/contacts/:contactId",
 *                    validateObjectId("id", "contactId"), handler)
 */
import { isValidObjectId } from "../../utils/crm/phone.util.js";

const validateObjectId = (...paramNames) => (req, res, next) => {
  for (const name of paramNames) {
    const value = req.params?.[name];
    if (value !== undefined && !isValidObjectId(value)) {
      return res.status(400).json({
        status: "error",
        message: `Invalid ${name}: must be a valid MongoDB ObjectId`,
      });
    }
  }
  next();
};

export default validateObjectId;
