import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { Container } from "./container";

/** Branded shell for the auth screens — mirrors the web login page. */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Container className="bg-neutral-950">
      <View className="flex-1 justify-center px-4 py-10">
        <View className="mb-8 items-center gap-3">
          <View className="flex-row items-center gap-2">
            <Text className="text-xl">📅</Text>
            <Text className="text-sm font-bold text-[#c23326]">QuickCalAI</Text>
          </View>
          <Text className="text-3xl font-bold text-white tracking-tight">{title}</Text>
          {subtitle ? (
            <Text className="text-center text-neutral-400 text-sm">{subtitle}</Text>
          ) : null}
        </View>
        <View className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-5">
          {children}
        </View>
        {footer ? <View className="mt-6 items-center">{footer}</View> : null}
      </View>
    </Container>
  );
}
