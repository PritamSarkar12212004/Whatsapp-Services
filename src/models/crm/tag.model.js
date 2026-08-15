import mongoose from "mongoose";

const tagSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userprofile",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    color: {
      type: String,
      trim: true,
      default: "#6b7280",
    },
  },
  { timestamps: true },
);

// A tag name must be unique per owner
tagSchema.index({ owner: 1, name: 1 }, { unique: true });

const Tag = mongoose.model("Tag", tagSchema);

export default Tag;
