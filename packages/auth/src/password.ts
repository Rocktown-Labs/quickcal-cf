import { compare } from "bcryptjs";
import { hashPassword, verifyPassword } from "better-auth/crypto";

// Keep Better Auth's default scrypt for new/reset passwords. Only exported
// Clerk bcrypt hashes use the compatibility verifier.
export const password = {
  hash: hashPassword,
  verify: async (input: { hash: string; password: string }) => {
    if (!input || typeof input.hash !== "string" || typeof input.password !== "string") {
      return false;
    }
    try {
      if (/^\$2[aby]\$\d{2}\$/.test(input.hash)) {
        return await compare(input.password, input.hash.replace(/^\$2y\$/, "$2b$"));
      }
      return await verifyPassword(input);
    } catch {
      // A malformed stored hash or unsupported algorithm must read as
      // "invalid credentials", not a 500.
      return false;
    }
  },
};
