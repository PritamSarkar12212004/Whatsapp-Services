import userProfileModel from "../../models/user/userProfile.model.js";

const profileSetupController = async (req, res) => {
  try {
    const { wpnumber, fullName, gender, age, profilePic } = req.body;

    const existingUser = await userProfileModel.findOne({
      wpnumber,
    });
    if (existingUser) {
      return res.status(409).json({
        message: "Profile already exists",
      });
    }

    const user = await userProfileModel.create({
      wpnumber,
      fullName,
      gender,
      age,
      profilePic,
    });

    const responseData = {
      wpnumber: user.wpnumber,
      fullName: user.fullName,
      gender: user.gender,
      age: user.age,
      profilePic: user.profilePic,
      _id: user._id,
    };

    return res.status(201).json({
      message: "Profile setup successful",
      data: responseData,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

export default profileSetupController;