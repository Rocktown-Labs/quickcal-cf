import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { stripeClient } from "@better-auth/stripe/client";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { ENV } from "../src/env";

export const authClient = createAuthClient({
  baseURL: ENV.EXPO_PUBLIC_SERVER_URL,
  plugins: [
    expoClient({
      scheme: Constants.expoConfig?.scheme as string,
      storagePrefix: Constants.expoConfig?.scheme as string,
      storage: SecureStore,
    }),
    stripeClient({ subscription: true }),
    adminClient(),
  ],
});
