import { createAuthClient } from "better-auth/client";
import { stripeClient } from "@better-auth/stripe/client";
import { adminClient } from "better-auth/client/plugins";
import { ENV } from "../env.public";

export const authClient = createAuthClient({
  baseURL: ENV.PUBLIC_SERVER_URL,
  plugins: [
    stripeClient({ subscription: true }),
    adminClient(),
  ],
});
