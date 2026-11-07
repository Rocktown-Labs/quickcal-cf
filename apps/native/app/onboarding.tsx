import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button, Input, Label, Spinner, TextField, useToast } from "heroui-native";
import { authClient } from "@/lib/auth-client";
import { useMe, useUpdateProfile } from "@/lib/queries";
import type { CalendarApp, UseCase } from "@/lib/api";
import { Container } from "@/components/container";

const USE_CASES: Array<{ value: UseCase; label: string; icon: string }> = [
  { value: "class", label: "Class schedule", icon: "🎓" },
  { value: "work", label: "Work shifts & rosters", icon: "💼" },
  { value: "conference", label: "Conference agendas", icon: "🎤" },
  { value: "events", label: "Events & flyers", icon: "🎟️" },
  { value: "other", label: "Something else", icon: "✨" },
];

const CALENDAR_APPS: Array<{ value: CalendarApp; label: string }> = [
  { value: "google", label: "Google Calendar" },
  { value: "apple", label: "Apple Calendar" },
  { value: "outlook", label: "Outlook" },
  { value: "other", label: "Another app" },
];

export default function OnboardingScreen() {
  const { toast } = useToast();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const me = useMe(Boolean(session?.user));
  const updateProfile = useUpdateProfile();

  const [useCases, setUseCases] = useState<Set<UseCase>>(new Set());
  const [calendarApp, setCalendarApp] = useState<CalendarApp | null>(null);
  const [phone, setPhone] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);

  // Redirect unauthenticated users and already-onboarded users.
  useEffect(() => {
    if (!sessionPending && !session?.user) router.replace("/login");
  }, [sessionPending, session]);

  useEffect(() => {
    if (me.data?.isOnboarded) router.replace("/");
  }, [me.data?.isOnboarded]);

  // Prefill once from the profile (never clobber in-progress edits).
  useEffect(() => {
    if (initialized || !me.data) return;
    setPhone(me.data.phoneNumber ?? "");
    setUseCases(
      new Set(
        (me.data.useCase ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value): value is UseCase => USE_CASES.some((item) => item.value === value)),
      ),
    );
    setCalendarApp(
      CALENDAR_APPS.some((item) => item.value === me.data?.calendarApp)
        ? (me.data.calendarApp as CalendarApp)
        : null,
    );
    setInitialized(true);
  }, [initialized, me.data]);

  function toggleUseCase(value: UseCase) {
    setUseCases((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function finish(skip = false) {
    const digits = phone.replace(/\D/g, "").length;
    if (!skip && phone.trim() && digits < 7) {
      toast.show({
        variant: "danger",
        label: "Include a country and area code, e.g. +15551234567.",
      });
      return;
    }

    setSaving(true);
    try {
      await updateProfile.mutateAsync({
        ...(skip
          ? {}
          : {
              useCase: [...useCases],
              ...(calendarApp ? { calendarApp } : {}),
              phoneNumber: phone.trim(),
            }),
        isOnboarded: true,
      });
      router.replace("/");
    } catch (err) {
      toast.show({
        variant: "danger",
        label: err instanceof Error ? err.message : "Couldn't save your setup.",
      });
    } finally {
      setSaving(false);
    }
  }

  if (sessionPending || me.isPending) {
    return (
      <Container className="bg-neutral-950" isScrollable={false}>
        <View className="flex-1 items-center justify-center">
          <Spinner size="lg" color="default" />
        </View>
      </Container>
    );
  }

  return (
    <Container className="bg-neutral-950">
      <View className="px-4 py-6 gap-6">
        <View className="items-center gap-2">
          <Text className="text-4xl">📅</Text>
          <Text className="text-3xl font-bold text-white tracking-tight">Welcome aboard</Text>
          <Text className="text-center text-neutral-400 text-sm">
            Three quick questions and we&apos;ll tailor the app to how you use it.
          </Text>
        </View>

        <View className="gap-3">
          <Text className="text-lg font-bold text-white">What will you turn into calendars?</Text>
          <Text className="text-sm text-neutral-400">Select all that apply.</Text>
          <View className="gap-2">
            {USE_CASES.map((item) => {
              const selected = useCases.has(item.value);
              return (
                <Pressable
                  key={item.value}
                  onPress={() => toggleUseCase(item.value)}
                  className={`flex-row items-center gap-3 rounded-xl border p-4 ${
                    selected
                      ? "border-[#c23326] bg-[#c23326]/10"
                      : "border-neutral-800 bg-neutral-900"
                  }`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected }}
                >
                  <Text className="text-2xl">{item.icon}</Text>
                  <Text className="text-sm font-semibold text-white flex-1">{item.label}</Text>
                  <Text className={`text-lg ${selected ? "text-[#c23326]" : "text-neutral-600"}`}>
                    {selected ? "✓" : "○"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View className="gap-3">
          <Text className="text-lg font-bold text-white">Where do you keep your calendar?</Text>
          <View className="flex-row flex-wrap gap-2">
            {CALENDAR_APPS.map((item) => {
              const selected = calendarApp === item.value;
              return (
                <Pressable
                  key={item.value}
                  onPress={() => setCalendarApp(item.value)}
                  className={`rounded-xl border px-4 py-3 ${
                    selected
                      ? "border-[#c23326] bg-[#c23326]/10"
                      : "border-neutral-800 bg-neutral-900"
                  }`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                >
                  <Text className="text-sm font-semibold text-white">{item.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View className="gap-2">
          <Text className="text-lg font-bold text-white">Phone number (optional)</Text>
          <Text className="text-sm text-neutral-400">
            Used only to prefill SMS delivery — never marketing.
          </Text>
          <TextField>
            <Label>Phone number</Label>
            <Input
              value={phone}
              onChangeText={setPhone}
              placeholder="+1 (555) 123-4567"
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
            />
          </TextField>
        </View>

        <View className="gap-2">
          <Button
            className="bg-[#c23326]"
            onPress={() => void finish(false)}
            isDisabled={saving || useCases.size === 0}
          >
            {saving ? <Spinner size="sm" color="default" /> : <Button.Label>Finish setup</Button.Label>}
          </Button>
          <Button variant="outline" onPress={() => void finish(true)} isDisabled={saving}>
            <Button.Label>Skip for now</Button.Label>
          </Button>
        </View>
      </View>
    </Container>
  );
}
