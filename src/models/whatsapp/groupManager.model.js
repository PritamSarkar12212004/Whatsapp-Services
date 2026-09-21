import mongoose from "mongoose";

const managerRuleSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    trigger: { type: String, default: "" },
    value: { type: String, default: "" },
    enabled: { type: Boolean, default: true },
  },
  { _id: false },
);

const scheduleSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    type: {
      type: String,
      enum: ["daily", "weekly", "once"],
      default: "daily",
    },
    time: { type: String, default: "09:00" },
    daysOfWeek: { type: [Number], default: [] },
    date: { type: Date, default: null },
    templateId: { type: String, default: null },
    message: { type: String, default: "" },
    enabled: { type: Boolean, default: true },
    lastRunAt: { type: Date, default: null },
  },
  { _id: true },
);

const groupManagerSchema = new mongoose.Schema(
  {
    /** Which WhatsApp number these rules belong to (null = primary number). */
    accountId: {
      type: String,
      default: null,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userprofile",
      required: true,
    },
    groupJid: { type: String, required: true },
    groupSubject: { type: String, default: "" },
    settings: {
      warningMessage: {
        type: String,
        default: "⚠️ {name}, please follow the group rules. Warning {strikes}/{limit}.",
      },
      strikeLimit: { type: Number, default: 3 },
      autoDelete: { type: Boolean, default: false },
    },
    commands: {
      enabled: { type: Boolean, default: false },
      rulesText: { type: String, default: "" },
      helpText: { type: String, default: "" },
    },
    rules: { type: [managerRuleSchema], default: [] },
    schedules: { type: [scheduleSchema], default: [] },
  },
  { timestamps: true },
);

groupManagerSchema.index(
  { userId: 1, accountId: 1, groupJid: 1 },
  { unique: true },
);

export default mongoose.model("groupmanager", groupManagerSchema);
