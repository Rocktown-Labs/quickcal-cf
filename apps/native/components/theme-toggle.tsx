import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Platform, Pressable } from "react-native";
import Animated, { FadeOut, ZoomIn } from "react-native-reanimated";
import { withUniwind } from "uniwind";
import { useAppTheme } from "@/contexts/app-theme-context";

const StyledIonicons = withUniwind(Ionicons);

export function ThemeToggle() {
  const { toggleTheme, isLight } = useAppTheme();
  const iconName = isLight ? "moon" : "sunny";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={isLight ? "Switch to dark theme" : "Switch to light theme"}
      hitSlop={12}
      onPress={() => {
        if (Platform.OS === "ios") {
          // Haptics are best-effort; an unsupported device must not break
          // the toggle or surface an unhandled rejection.
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        }
        toggleTheme();
      }}
      className="px-2.5 py-2.5"
    >
      <Animated.View key={iconName} entering={ZoomIn} exiting={FadeOut}>
        <StyledIonicons name={iconName} size={20} className="text-foreground" />
      </Animated.View>
    </Pressable>
  );
}
