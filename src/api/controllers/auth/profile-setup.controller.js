import userProfileModel from "../../../models/user/userProfile.model.js";
import { generateToken } from "../../../utils/token/jwt.util.js";

const profileSetupController = async (req, res) => {
  try {
    const { fullName, gender, age } = req.body;

    // Get wpnumber from authenticated JWT (req.user)
    const wpnumber = req.user?.wpnumber;

    if (!wpnumber) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated",
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
    });

    // Generate a new JWT with userId after profile creation
    const token = generateToken({
      userId: user._id,
      wpnumber: user.wpnumber,
    });

    const responseData = {
      wpnumber: user.wpnumber,
      fullName: user.fullName,
      gender: user.gender,
      age: user.age,
      _id: user._id,
    };

    return res.status(201).json({
      status: "success",
      message: "Profile setup successful",
      data: responseData,
      token,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

export default profileSetupController;