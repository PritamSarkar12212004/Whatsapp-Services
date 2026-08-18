/**
 * Pure helpers for the contact service.
 *
 * @see contact.service.js (main service that imports these)
 */

import tagService from "../tag.service.js";
import contactGroupService from "../contactGroup.service.js";

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Escape user input for use inside a RegExp. */
export const escapeRegex = (s) =>
  String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Resolve an array of tag/cell names into ObjectIds, auto-creating the
 * missing ones. Returns the array of ObjectIds.
 */
export const resolveTagIds = async (ownerId, names) => {
  if (!Array.isArray(names) || !names.length) return [];
  const { tagIds, newTagNames } = await tagService.resolveTagNames(
    ownerId,
    names,
  );
  const allIds = [...tagIds];
  if (newTagNames.length) {
    const created = await Promise.all(
      newTagNames.map((n) => tagService.createTag(ownerId, { name: n })),
    );
    allIds.push(...created.map((t) => t._id));
  }
  return allIds;
};

/**
 * Resolve an array of group names into ObjectIds, auto-creating the
 * missing ones. Returns the array of ObjectIds.
 */
export const resolveGroupIds = async (ownerId, names) => {
  if (!Array.isArray(names) || !names.length) return [];
  const { groupIds, newGroupNames } =
    await contactGroupService.resolveGroupNames(ownerId, names);
  const allIds = [...groupIds];
  if (newGroupNames.length) {
    const created = await Promise.all(
      newGroupNames.map((n) =>
        contactGroupService.createGroup(ownerId, { name: n }),
      ),
    );
    allIds.push(...created.map((g) => g._id));
  }
  return allIds;
};

/**
 * Parse a "key:value;key2:value2" string into [{ key, value }].
 */
export const parseCustomFields = (str) => {
  if (!str || typeof str !== "string") return [];
  return str
    .split(";")
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx <= 0) return null;
      return {
        key: pair.slice(0, idx).trim(),
        value: pair.slice(idx + 1).trim(),
      };
    })
    .filter(Boolean);
};
