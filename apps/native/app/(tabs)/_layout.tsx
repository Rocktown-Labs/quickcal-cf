import { Redirect, Tabs } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useColorScheme } from "react-native";
import { Button } from "heroui-native";
import { authClient } from "@/lib/auth-client";
import { useMe } from "@/lib/queries";
import { BRAND } from "@/components/qc";

const TABS = [
  { name: "index", title: "Home", icon: "📤" },
  { name: "files", title: "Files", icon: "📄" },
  { name: "settings", title: "Settings", icon: "⚙️" },
] as const;

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  tabIcon: { fontSize: 20 },
});

export default function TabsLayout() {
  const { data: session, isPending } = authClient.useSession();
  const me = useMe(Boolean(session?.user));
  const colorScheme = useColorScheme();
  const isDark = colorScheme !== "light";

  if (isPending) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!session?.user) {
    return <Redirect href="/login" />;
  }
  if (me.isPending) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }
  if (me.isError) {
    return (
      <View style={styles.centered}>
        <Text className="text-neutral-400 text-sm mb-3">Couldn&apos;t load your account.</Text>
        <Button size="sm" onPress={() => void me.refetch()}>
          <Button.Label>Retry</Button.Label>
        </Button>
      </View>
    );
  }
  if (me.data && !me.data.isOnboarded) {
    return <Redirect href="/onboarding" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: isDark ? "#0a0a0a" : "#ffffff",
          borderTopColor: isDark ? "#262626" : "#e5e5e5",
        },
        tabBarActiveTintColor: BRAND.red,
        tabBarInactiveTintColor: isDark ? "#737373" : "#a3a3a3",
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            tabBarIcon: () => <Text style={styles.tabIcon}>{tab.icon}</Text>,
          }}
        />
      ))}
    </Tabs>
  );
}
