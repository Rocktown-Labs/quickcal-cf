import { compare } from "bcryptjs";
import { hashPassword, verifyPassword } from "better-auth/crypto";

// Keep Better Auth's default scrypt for new/reset passwords. Only exported
// Clerk bcrypt hashes use the compatibility verifier.
export const password = {
  hash: hashPassword,
  verify: async (input: { hash: string; password: string }) => {
    if (/^\$2[aby]\$\d{2}\$/.test(input.hash)) {
      return compare(input.password, input.hash.replace(/^\$2y\$/, "$2b$"));
    }
    return verifyPassword(input);
  },
};
