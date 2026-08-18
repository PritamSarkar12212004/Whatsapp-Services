import mongoose from "mongoose";

const groupWarningLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userprofile",
      required: true,
      index: true,
    },
    groupJid: { type: String, required: true },
    groupSubject: { type: String, default: "" },
    memberJid: { type: String, required: true },
    memberName: { type: String, default: "" },
    memberNumber: { type: String, default: "" },
    reason: { type: String, default: "banned_words" },
    message: { type: String, default: "" },
    strikes: { type: Number, default: 1 },
    action: { type: String, default: "warning" },
  },
  { timestamps: true },
);

groupWarningLogSchema.index({ userId: 1, groupJid: 1, memberJid: 1 });

export default mongoose.model("groupwarninglog", groupWarningLogSchema);
