import groupManagerModel from "../../models/whatsapp/groupManager.model.js";
import groupWarningLogModel from "../../models/whatsapp/groupWarningLog.model.js";
import { invalidateManagerCache } from "../../whatsapp/groupAutomation.service.js";

const RULE_TYPES = [
  "welcome",
  "goodbye",
  "auto_reply",
  "banned_words",
  "anti_link",
  "anti_flood",
];

const requireGroupId = (req, res) => {
  const userId = req.user?.userId;
  const groupJid = req.params.id;

  if (!userId) {
    res.status(401).json({
      status: "error",
      message: "User not authenticated",
    });
    return null;
  }

  if (!groupJid) {
    res.status(400).json({
      status: "error",
      message: "Group id is required",
    });
    return null;
  }

  return { userId, groupJid };
};

const sanitizeRules = (rules) => {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((r) => r && typeof r.type === "string" && RULE_TYPES.includes(r.type))
    .map((r) => ({
      type: r.type,
      trigger: String(r.trigger ?? ""),
      value: String(r.value ?? ""),
      enabled: r.enabled !== false,
    }));
};

const sanitizeSchedules = (schedules) => {
  if (!Array.isArray(schedules)) return [];
  return schedules.map((s) => ({
    _id: s._id || undefined,
    name: String(s.name ?? ""),
    type: ["daily", "weekly", "once"].includes(s.type) ? s.type : "daily",
    time: /^\d{2}:\d{2}$/.test(s.time || "") ? s.time : "09:00",
    daysOfWeek: Array.isArray(s.daysOfWeek)
      ? s.daysOfWeek.map(Number).filter((d) => d >= 0 && d <= 6)
      : [],
    date: s.date ? new Date(s.date) : null,
    templateId: s.templateId ? String(s.templateId) : null,
    message: String(s.message ?? ""),
    enabled: s.enabled !== false,
    lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
  }));
};

const getGroupManagerController = async (req, res) => {
  try {
    const ids = requireGroupId(req, res);
    if (!ids) return;

    const manager = await groupManagerModel.findOne({
      userId: ids.userId,
      groupJid: ids.groupJid,
    });

    return res.status(200).json({
      status: "success",
      data: manager || null,
    });
  } catch (err) {
    console.error("Error getting group manager:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to get group manager",
    });
  }
};

const saveGroupManagerController = async (req, res) => {
  try {
    const ids = requireGroupId(req, res);
    if (!ids) return;

    const { groupSubject, settings, commands, rules, schedules } =
      req.body || {};

    const manager = await groupManagerModel.findOneAndUpdate(
      { userId: ids.userId, groupJid: ids.groupJid },
      {
        $set: {
          groupSubject: String(groupSubject ?? ""),
          settings: {
            warningMessage: String(
              settings?.warningMessage ??
                "⚠️ {name}, please follow the group rules. Warning {strikes}/{limit}.",
            ),
            strikeLimit: Math.min(
              10,
              Math.max(1, Number(settings?.strikeLimit) || 3),
            ),
            autoDelete: Boolean(settings?.autoDelete),
          },
          commands: {
            enabled: Boolean(commands?.enabled),
            rulesText: String(commands?.rulesText ?? ""),
            helpText: String(commands?.helpText ?? ""),
          },
          rules: sanitizeRules(rules),
          schedules: sanitizeSchedules(schedules),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    invalidateManagerCache(ids.userId, ids.groupJid);

    return res.status(200).json({
      status: "success",
      data: manager,
    });
  } catch (err) {
    console.error("Error saving group manager:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to save group manager",
    });
  }
};

const deleteGroupManagerController = async (req, res) => {
  try {
    const ids = requireGroupId(req, res);
    if (!ids) return;

    const result = await groupManagerModel.deleteOne({
      userId: ids.userId,
      groupJid: ids.groupJid,
    });

    invalidateManagerCache(ids.userId, ids.groupJid);

    return res.status(200).json({
      status: "success",
      deleted: result.deletedCount > 0,
    });
  } catch (err) {
    console.error("Error deleting group manager:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to delete group manager",
    });
  }
};

const getGroupWarningsController = async (req, res) => {
  try {
    const ids = requireGroupId(req, res);
    if (!ids) return;

    const warnings = await groupWarningLogModel
      .find({ userId: ids.userId, groupJid: ids.groupJid })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.status(200).json({
      status: "success",
      data: warnings,
    });
  } catch (err) {
    console.error("Error getting group warnings:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to get group warnings",
    });
  }
};

export {
  getGroupManagerController,
  saveGroupManagerController,
  deleteGroupManagerController,
  getGroupWarningsController,
};
