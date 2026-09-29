import { Redirect, Tabs } from "expo-router";
import { Text } from "react-native";
import { useColorScheme } from "react-native";
import { authClient } from "@/lib/auth-client";

const TABS = [
  { name: "index", title: "Home", icon: "📤" },
  { name: "files", title: "Files", icon: "📄" },
  { name: "settings", title: "Settings", icon: "⚙️" },
] as const;

export default function TabsLayout() {
  const { data: session, isPending } = authClient.useSession();
  const colorScheme = useColorScheme();
  const isDark = colorScheme !== "light";

  if (isPending) {
    return null;
  }
  if (!session?.user) {
    return <Redirect href="/login" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: isDark ? "#0a0a0a" : "#ffffff",
          borderTopColor: isDark ? "#262626" : "#e5e5e5",
        },
        tabBarActiveTintColor: "#c23326",
        tabBarInactiveTintColor: isDark ? "#737373" : "#a3a3a3",
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            tabBarIcon: () => <Text style={{ fontSize: 20 }}>{tab.icon}</Text>,
          }}
        />
      ))}
    </Tabs>
  );
}
