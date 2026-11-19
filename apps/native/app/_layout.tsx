import "@/global.css";

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { HeroUINativeProvider } from "heroui-native";
import { useEffect, useRef } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { authClient } from "@/lib/auth-client";
import { AppThemeProvider } from "@/contexts/app-theme-context";

import { StyleSheet } from "react-native";

export const unstable_settings = {
  anchor: "(tabs)",
};

const styles = StyleSheet.create({
  root: { flex: 1 },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Clears the React Query cache when the signed-in user changes. Without this,
 * a sign-out/sign-in on a shared device can briefly show the previous user's
 * profile, premium state, uploads, or API keys from cache.
 */
function SessionCacheGuard() {
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const lastUserId = useRef<string | null>(null);

  useEffect(() => {
    const userId = session?.user?.id ?? null;
    if (lastUserId.current && lastUserId.current !== userId) {
      queryClient.clear();
    }
    lastUserId.current = userId;
  }, [session?.user?.id, queryClient]);

  return null;
}

function StackLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="onboarding" options={{ animation: "fade" }} />
      <Stack.Screen name="login" options={{ animation: "fade" }} />
      <Stack.Screen name="signup" options={{ animation: "fade" }} />
      <Stack.Screen name="forgot-password" options={{ animation: "fade" }} />
      <Stack.Screen name="reset-password" options={{ animation: "fade" }} />
    </Stack>
  );
}

export default function Layout() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.root}>
        <KeyboardProvider>
          <AppThemeProvider>
            <HeroUINativeProvider>
              <QueryClientProvider client={queryClient}>
                <SessionCacheGuard />
                <StackLayout />
              </QueryClientProvider>
            </HeroUINativeProvider>
          </AppThemeProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
