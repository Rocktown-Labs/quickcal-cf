import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { stripeClient } from "@better-auth/stripe/client";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { ENV } from "../src/env";
import { normalizeBaseUrl } from "./env-url";

const rawScheme = Constants.expoConfig?.scheme;
const scheme = Array.isArray(rawScheme) ? rawScheme[0] : rawScheme;
if (!scheme) {
  throw new Error("The Expo app scheme is not configured (app.json expo.scheme).");
}

export const authClient = createAuthClient({
  baseURL: normalizeBaseUrl(ENV.EXPO_PUBLIC_SERVER_URL, "EXPO_PUBLIC_SERVER_URL"),
  plugins: [
    expoClient({
      scheme,
      storagePrefix: scheme,
      storage: SecureStore,
    }),
    stripeClient({ subscription: true }),
    adminClient(),
  ],
});
