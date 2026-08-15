import mongoose from "mongoose";

const contactGroupSchema = new mongoose.Schema(
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
    },

    description: {
      type: String,
      trim: true,
      default: "",
    },

    contacts: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Contact",
        default: [],
      },
    ],
  },
  { timestamps: true },
);

// A group name must be unique per owner
contactGroupSchema.index({ owner: 1, name: 1 }, { unique: true });

const ContactGroup = mongoose.model("ContactGroup", contactGroupSchema);

export default ContactGroup;