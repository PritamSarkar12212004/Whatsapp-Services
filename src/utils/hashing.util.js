import argon2 from "argon2";

export const hashing = async (data) => {
  const hash = await argon2.hash(data, { type: argon2.argon2id });
  return hash;
};

export const decryptHashing = async (storeOtp, otp) => {
  const hash = await argon2.verify(storeOtp, otp);
  return hash;
};