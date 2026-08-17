import Tag from "../../models/messaging/tag.model.js";

const tagService = {
  /** List all tags for the authenticated owner. */
  async listTags(ownerId) {
    return Tag.find({ owner: ownerId }).sort({ name: 1 }).exec();
  },

  /** Create a tag. Duplicate names (per owner) are rejected by the
   *  unique index; we surface a friendly error instead of a raw E11000. */
  async createTag(ownerId, data) {
    try {
      const tag = await Tag.create({
        owner: ownerId,
        name: String(data.name || "").trim().toLowerCase(),
        color: data.color || "#6b7280",
      });
      return tag;
    } catch (err) {
      if (err.code === 11000) {
        const e = new Error("Tag already exists");
        e.statusCode = 409;
        throw e;
      }
      throw err;
    }
  },

  /** Update an existing tag owned by the user. */
  async updateTag(ownerId, id, data) {
    const updates = {};
    if (data.name !== undefined) {
      updates.name = String(data.name).trim().toLowerCase();
    }
    if (data.color !== undefined) updates.color = data.color;

    const tag = await Tag.findOneAndUpdate(
      { _id: id, owner: ownerId },
      { $set: updates },
      { new: true, runValidators: true },
    ).exec();

    if (!tag) {
      const e = new Error("Tag not found");
      e.statusCode = 404;
      throw e;
    }
    return tag;
  },

  /** Delete a tag and remove all references to it from contacts. */
  async deleteTag(ownerId, id) {
    const Contact = (await import("../../models/messaging/contact.model.js")).default;
    const tag = await Tag.findOneAndDelete({ _id: id, owner: ownerId }).exec();
    if (!tag) {
      const e = new Error("Tag not found");
      e.statusCode = 404;
      throw e;
    }
    // Remove dangling references so analytics stay consistent
    await Contact.updateMany(
      { owner: ownerId, tags: id },
      { $pull: { tags: id } },
    ).exec();
    return tag;
  },

  /** Resolve tag names belonging to an owner into ObjectId refs.
   *  Returns { tagIds, newTagNames } where newTagNames are names that
   *  did not exist yet (callers may choose to create them). */
  async resolveTagNames(ownerId, tagNames) {
    if (!Array.isArray(tagNames) || tagNames.length === 0) {
      return { tagIds: [], newTagNames: [] };
    }
    const normalised = tagNames
      .map((t) => String(t || "").trim().toLowerCase())
      .filter(Boolean);

    const existing = await Tag.find({
      owner: ownerId,
      name: { $in: normalised },
    }).exec();

    const existingNames = new Set(existing.map((t) => t.name));
    const newTagNames = normalised.filter((n) => !existingNames.has(n));
    const tagIds = existing.map((t) => t._id);

    return { tagIds, newTagNames };
  },
};

export default tagService;
