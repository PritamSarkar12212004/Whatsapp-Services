import userProfileModel from "../../models/user/userProfile.model.js";

const profileSetupController = async (req, res) => {
  try {
    const { fullName, gender, age, profilePic } = req.body;

    const wpnumber = req.user?.wpnumber;

    if (!wpnumber) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized. Invalid user token.",
      });
    }

    if (!fullName || !gender || !age) {
      return res.status(400).json({
        status: "error",
        message: "Full name, gender and age are required",
      });
    }

    const existingUser = await userProfileModel.findOne({
      wpnumber,
    });

    if (existingUser) {
      return res.status(409).json({
        status: "error",
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
      _id: user._id,
      wpnumber: user.wpnumber,
      fullName: user.fullName,
      gender: user.gender,
      age: user.age,
      profilePic: user.profilePic,
    };

    return res.status(201).json({
      status: "success",
      message: "Profile setup successful",
      data: responseData,
    });
  } catch (err) {
    console.error("Profile setup error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
};

export default profileSetupController;