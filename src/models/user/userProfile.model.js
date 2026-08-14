import mongoose from "mongoose";

const userProfileSchema = new mongoose.Schema(
  {
    wpnumber: {
      type: String,
      required: true,
      unique: true,
      match: /^[0-9]{10}$/,
    },

    fullName: {
      type: String,
      required: true,
      trim: true,
    },

    gender: {
      type: String,
      enum: ["male", "female", "other"],
      required: true,
    },

    age: {
      type: Number,
      required: true,
    },

    profilePic: {
      type: String,
      default: null,
    },
  },
  { timestamps: true },
);

export default mongoose.model("userprofile", userProfileSchema);