import ContactGroup from "../../models/messaging/contactGroup.model.js";
import Contact from "../../models/messaging/contact.model.js";
import activityService from "./activity.service.js";

const contactGroupService = {
  /** List groups for the owner with optional contact counts. */
  async listGroups(ownerId) {
    return ContactGroup.find({ owner: ownerId })
      .sort({ name: 1 })
      .populate("contacts", "name phoneNumber")
      .exec();
  },

  async getGroup(ownerId, id) {
    const group = await ContactGroup.findOne({ _id: id, owner: ownerId })
      .populate("contacts", "name phoneNumber")
      .exec();
    if (!group) {
      const e = new Error("Group not found");
      e.statusCode = 404;
      throw e;
    }
    return group;
  },

  async createGroup(ownerId, data) {
    try {
      const group = await ContactGroup.create({
        owner: ownerId,
        name: String(data.name || "").trim(),
        description: data.description || "",
        contacts: [],
      });
      return group;
    } catch (err) {
      if (err.code === 11000) {
        const e = new Error("Group already exists");
        e.statusCode = 409;
        throw e;
      }
      throw err;
    }
  },

  async updateGroup(ownerId, id, data) {
    const updates = {};
    if (data.name !== undefined) updates.name = String(data.name).trim();
    if (data.description !== undefined)
      updates.description = data.description;

    const group = await ContactGroup.findOneAndUpdate(
      { _id: id, owner: ownerId },
      { $set: updates },
      { new: true, runValidators: true },
    ).exec();

    if (!group) {
      const e = new Error("Group not found");
      e.statusCode = 404;
      throw e;
    }
    return group;
  },

  async deleteGroup(ownerId, id) {
    const group = await ContactGroup.findOneAndDelete({
      _id: id,
      owner: ownerId,
    }).exec();
    if (!group) {
      const e = new Error("Group not found");
      e.statusCode = 404;
      throw e;
    }
    // Remove dangling group references from contacts
    await Contact.updateMany(
      { owner: ownerId, customGroups: id },
      { $pull: { customGroups: id } },
    ).exec();
    return group;
  },

  /**
   * Add existing contacts to a group.
   * Contacts are validated to belong to the owner; duplicates are ignored.
   * Returns the list of contactIds that were newly added.
   */
  async addContacts(ownerId, id, contactIds) {
    const group = await ContactGroup.findOne({ _id: id, owner: ownerId });
    if (!group) {
      const e = new Error("Group not found");
      e.statusCode = 404;
      throw e;
    }

    // Validate that the contacts belong to this owner
    const validContacts = await Contact.find({
      owner: ownerId,
      _id: { $in: contactIds },
    }).select("_id").exec();

    const existing = new Set(
      group.contacts.map((c) => c.toString()),
    );

    const toAdd = [];
    for (const c of validContacts) {
      const cid = c._id.toString();
      if (!existing.has(cid)) {
        toAdd.push(c._id);
        existing.add(cid);
      }
    }

    if (toAdd.length > 0) {
      group.contacts.push(...toAdd);
      await group.save();

      // Keep the reverse mapping on contacts in sync
      await Contact.updateMany(
        { owner: ownerId, _id: { $in: toAdd } },
        { $addToSet: { customGroups: id } },
      ).exec();

      // Activity log (fire-and-forget, batched)
      for (const cid of toAdd) {
        activityService.logActivity(
          ownerId,
          cid,
          "added_to_group",
          { groupId: id },
        );
      }
    }

    return {
      added: toAdd.length,
      alreadyInGroup: contactIds.length - toAdd.length - (contactIds.length - validContacts.length),
      notFoundOrNotOwned: contactIds.length - validContacts.length,
      group,
    };
  },

  /**
   * Remove a contact from a group (clears the reverse reference too).
   */
  async removeContact(ownerId, id, contactId) {
    const group = await ContactGroup.findOneAndUpdate(
      { _id: id, owner: ownerId },
      { $pull: { contacts: contactId } },
      { new: true },
    ).exec();

    if (!group) {
      const e = new Error("Group not found");
      e.statusCode = 404;
      throw e;
    }

    // Remove reverse reference
    await Contact.updateOne(
      { _id: contactId, owner: ownerId },
      { $pull: { customGroups: id } },
    ).exec();

    activityService.logActivity(
      ownerId,
      contactId,
      "removed_from_group",
      { groupId: id },
    );

    return group;
  },

  /**
   * Resolve group names belonging to an owner into ObjectId refs.
   * Returns { groupIds, newGroupNames }.
   */
  async resolveGroupNames(ownerId, groupNames) {
    if (!Array.isArray(groupNames) || groupNames.length === 0) {
      return { groupIds: [], newGroupNames: [] };
    }
    const normalised = groupNames
      .map((g) => String(g || "").trim())
      .filter(Boolean);

    const existing = await ContactGroup.find({
      owner: ownerId,
      name: { $in: normalised },
    }).exec();

    const existingNames = new Set(existing.map((g) => g.name.toLowerCase()));
    const newGroupNames = normalised.filter(
      (n) => !existingNames.has(n.toLowerCase()),
    );
    const groupIds = existing.map((g) => g._id);

    return { groupIds, newGroupNames };
  },
};

export default contactGroupService;
