import { useEffect, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

// ─── Brand palette (mirrors the web app) ───────────────────────────────────

export const BRAND = {
  red: "#c23326",
  redHover: "#d43d2f",
  green: "#22c55e",
} as const;

// ─── Press feedback ─────────────────────────────────────────────────────────
// 100–150ms scale on press-in; commit on release (animate-expo §7).

export function PressCard({
  children,
  onPress,
  className,
  disabled,
}: {
  children: ReactNode;
  onPress?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const pressed = useSharedValue(0);
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        scale: withTiming(pressed.get() === 1 ? 0.97 : 1, {
          duration: 120,
          reduceMotion: ReduceMotion.System,
        }),
      },
    ],
  }));

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => pressed.set(1)}
      onPressOut={() => pressed.set(0)}
      disabled={disabled}
      accessibilityRole="button"
    >
      <Animated.View style={style} className={className}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

// ─── Pulsing element ────────────────────────────────────────────────────────
// Native twin of the web's `animate-pulse` on the processing banner and the
// event-count placeholder. Opacity-only loop, disabled under reduced motion.

export function Pulse({ children, className }: { children: ReactNode; className?: string }) {
  const opacity = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  useEffect(() => {
    opacity.set(
      withRepeat(
        withTiming(0.55, {
          duration: 1000,
          reduceMotion: ReduceMotion.System,
        }),
        -1,
        true,
      ),
    );
  }, [opacity]);

  return (
    <Animated.View style={style} className={className}>
      {children}
    </Animated.View>
  );
}

// ─── Processing progress bar ───────────────────────────────────────────────
// An absolutely-positioned fill with no children → animating width is the
// allowed exception and keeps the rounded ends (animate-expo §4). The 500ms
// ease-out matches the web's `transition-all duration-500 ease-out`.

export function ProgressBar({ progress }: { progress: number }) {
  const width = useSharedValue(0);
  const style = useAnimatedStyle(() => ({
    width: `${Math.min(Math.max(width.get(), 0), 99)}%`,
  }));

  useEffect(() => {
    width.set(
      withTiming(Math.min(Math.max(progress, 0), 99), {
        duration: 500,
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [progress, width]);

  return (
    <View className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
      <Animated.View style={[{ height: "100%" }, style]} className="bg-[#c23326] rounded-full" />
    </View>
  );
}

// ─── Status chip (Files list) ──────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  completed: "bg-green-950",
  processing: "bg-blue-950",
  pending: "bg-blue-950",
  no_events: "bg-amber-950",
  failed: "bg-red-950",
};

export function StatusChip({ status }: { status: string }) {
  return (
    <View
      className={`${STATUS_COLORS[status] ?? "bg-neutral-800"} rounded-full px-2.5 py-1 self-start`}
    >
      <Text className="text-white text-xs font-bold">{status.replace("_", " ")}</Text>
    </View>
  );
}
