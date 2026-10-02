import { useState } from "react";
import { Text, View } from "react-native";
import { Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Button, Input, Label, Spinner, TextField, useToast } from "heroui-native";
import { authClient } from "@/lib/auth-client";
import { api } from "@/lib/api";
import {
  useApiKeys,
  useCreateApiKey,
  useDeleteApiKey,
  useMe,
  useRotateCalendarFeed,
  useUpdateProfile,
} from "@/lib/queries";
import { PressCard } from "@/components/qc";
import { Container } from "@/components/container";
import { ThemeToggle } from "@/components/theme-toggle";

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 gap-3">
      <Text className="font-bold text-lg text-white">{title}</Text>
      {children}
    </View>
  );
}

export default function SettingsScreen() {
  const { data: session } = authClient.useSession();
  const me = useMe();
  const updateProfile = useUpdateProfile();
  const rotateFeed = useRotateCalendarFeed();
  const keys = useApiKeys();
  const createKey = useCreateApiKey();
  const deleteKey = useDeleteApiKey();
  const { toast } = useToast();

  const [phone, setPhone] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const profile = me.data;
  const isPremium = profile?.isPremium ?? false;
  const isVerified = session?.user?.emailVerified ?? true;
  const phoneValue = phone ?? profile?.phoneNumber ?? "";

  async function saveProfile() {
    try {
      await updateProfile.mutateAsync({ phoneNumber: phoneValue.trim(), isOnboarded: true });
      toast.show({ variant: "success", label: "Saved." });
    } catch (err) {
      toast.show({ variant: "danger", label: err instanceof Error ? err.message : "Save failed." });
    }
  }

  async function upgrade() {
    try {
      await authClient.subscription.upgrade({
        plan: "premium",
        successUrl: "quickcal-cf://settings",
        cancelUrl: "quickcal-cf://settings",
      });
    } catch (err) {
      toast.show({
        variant: "danger",
        label: err instanceof Error ? err.message : "Upgrade failed.",
      });
    }
  }

  async function manageBilling() {
    try {
      await authClient.subscription.billingPortal({ returnUrl: "quickcal-cf://settings" });
    } catch (err) {
      toast.show({
        variant: "danger",
        label: err instanceof Error ? err.message : "Could not open portal.",
      });
    }
  }

  async function cancelSubscription() {
    Alert.alert("Cancel subscription?", "You'll keep Premium until the end of the period.", [
      { text: "Keep Premium", style: "cancel" },
      {
        text: "Cancel Subscription",
        style: "destructive",
        onPress: () =>
          void authClient.subscription
            .cancel({ returnUrl: "quickcal-cf://settings" })
            .catch((err: unknown) =>
              toast.show({
                variant: "danger",
                label: err instanceof Error ? err.message : "Cancel failed.",
              }),
            ),
      },
    ]);
  }

  async function handleCreateKey() {
    const name = keyName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const created = await createKey.mutateAsync(name);
      setNewKey(created.key);
      setKeyName("");
    } catch (err) {
      toast.show({
        variant: "danger",
        label: err instanceof Error ? err.message : "Could not create key.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    if (!session?.user?.email) return;
    const { error } = await authClient.sendVerificationEmail({
      email: session.user.email,
      callbackURL: "/(tabs)/settings",
    });
    toast.show({
      variant: error ? "danger" : "success",
      label: error ? "Couldn't send — try again" : "Sent! Check your inbox",
    });
  }

  return (
    <Container className="bg-neutral-950">
      <View className="px-4 pt-6 pb-4">
        <Text className="text-3xl font-bold text-white mb-1">Settings</Text>
        <Text className="text-neutral-400">
          Manage contact info, API keys, and your subscription.
        </Text>
      </View>

      <View className="px-4 gap-4 pb-10">
        {!isVerified ? (
          <SectionCard title="Verify your email">
            <Text className="text-neutral-400 text-sm">
              Confirm {session?.user?.email ?? "your email"} to secure your account and enable
              password recovery.
            </Text>
            <Button size="sm" className="bg-amber-700" onPress={() => void resendVerification()}>
              <Button.Label>Resend verification email</Button.Label>
            </Button>
          </SectionCard>
        ) : null}

        <SectionCard title="Profile">
          <TextField>
            <Label>Name</Label>
            <Input value={profile?.name ?? ""} editable={false} />
          </TextField>
          <TextField>
            <Label>Email</Label>
            <Input value={profile?.email ?? ""} editable={false} keyboardType="email-address" />
          </TextField>
          <TextField>
            <Label>Phone Number</Label>
            <Input
              value={phoneValue}
              onChangeText={setPhone}
              placeholder="+1 (555) 123-4567"
              keyboardType="phone-pad"
            />
            <Text className="text-xs text-neutral-500 mt-1">
              Used to prefill SMS delivery. International format, e.g. +15551234567.
            </Text>
          </TextField>
          <Button
            className="bg-[#c23326] self-start"
            onPress={() => void saveProfile()}
            isDisabled={updateProfile.isPending}
          >
            {updateProfile.isPending ? (
              <Spinner size="sm" color="default" />
            ) : (
              <Button.Label>Save</Button.Label>
            )}
          </Button>
        </SectionCard>

        <SectionCard title="Subscription">
          {isPremium ? (
            <>
              <View className="flex-row items-center gap-2">
                <View className="bg-[#c23326] rounded-full px-3 py-1">
                  <Text className="text-white text-xs font-bold">PREMIUM</Text>
                </View>
                <Text className="text-neutral-400 text-sm">
                  AI uploads, email & SMS delivery enabled.
                </Text>
              </View>
              <View className="flex-row gap-2 flex-wrap">
                <Button size="sm" variant="outline" onPress={() => void manageBilling()}>
                  <Button.Label>Manage Billing</Button.Label>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-red-900"
                  onPress={() => void cancelSubscription()}
                >
                  <Button.Label className="text-red-400">Cancel Subscription</Button.Label>
                </Button>
              </View>
            </>
          ) : (
            <>
              <Text className="text-neutral-400 text-sm">
                Free plan — AI uploads and delivery require Premium.
              </Text>
              <Button className="bg-[#c23326]" onPress={() => void upgrade()}>
                <Button.Label>Upgrade to Premium — $12.99/mo</Button.Label>
              </Button>
            </>
          )}
        </SectionCard>

        <SectionCard title="API Keys">
          <Text className="text-neutral-400 text-sm">
            Let AI agents and scripts act on your behalf with{" "}
            <Text className="text-white">Authorization: Bearer qc_…</Text>. Keys are shown once.
          </Text>
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Input value={keyName} onChangeText={setKeyName} placeholder="e.g. claude-agent" />
            </View>
            <Button
              className="bg-[#c23326]"
              onPress={() => void handleCreateKey()}
              isDisabled={busy || !keyName.trim()}
            >
              {busy ? <Spinner size="sm" color="default" /> : <Button.Label>Create</Button.Label>}
            </Button>
          </View>

          {newKey ? (
            <View className="rounded-lg border border-green-500/30 bg-green-500/10 p-4 gap-1">
              <Text className="text-sm font-bold text-green-500">
                Copy this key now — it won't be shown again:
              </Text>
              <Text className="text-sm text-white" selectable>
                {newKey}
              </Text>
            </View>
          ) : null}

          <View className="gap-2">
            {(keys.data?.keys ?? []).map((k) => (
              <View
                key={k.id}
                className="flex-row items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3"
              >
                <View className="flex-1">
                  <Text className="text-white text-sm font-semibold" numberOfLines={1}>
                    {k.name}
                  </Text>
                  <Text className="text-neutral-500 text-xs font-mono">
                    {k.keyPrefix}…{" · "}
                    {k.lastUsedAt
                      ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                      : "never used"}
                  </Text>
                </View>
                <PressCard
                  onPress={() =>
                    Alert.alert("Revoke this API key?", "Agents using it will lose access.", [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Revoke",
                        style: "destructive",
                        onPress: () =>
                          void deleteKey
                            .mutateAsync(k.id)
                            .catch(() =>
                              toast.show({ variant: "danger", label: "Revoke failed." }),
                            ),
                      },
                    ])
                  }
                  className="px-3 py-1.5 border border-red-900 rounded-lg"
                >
                  <Text className="text-red-400 text-xs font-bold">Revoke</Text>
                </PressCard>
              </View>
            ))}
          </View>
        </SectionCard>

        <SectionCard title="Agents & integrations">
          <Text className="text-neutral-400 text-sm">
            Everything an AI agent (or a calendar app) needs to work with your account.
          </Text>

          <View className="gap-1.5">
            <Text className="text-white text-sm font-semibold">Calendar feed</Text>
            <Text className="text-neutral-500 text-xs">
              Every event you own, always current. Add by URL in Google Calendar, or webcal:// in
              Apple Calendar.
            </Text>
            <Text className="text-neutral-300 text-xs" selectable>
              {me.data?.calendarFeedPath ? `${api.serverUrl()}${me.data.calendarFeedPath}` : "…"}
            </Text>
            <View className="flex-row gap-2">
              <Button
                size="sm"
                variant="outline"
                onPress={() => {
                  void Clipboard.setStringAsync(
                    me.data?.calendarFeedPath
                      ? `${api.serverUrl()}${me.data.calendarFeedPath}`
                      : "",
                  );
                  toast.show({ variant: "success", label: "Feed URL copied." });
                }}
              >
                <Button.Label>Copy URL</Button.Label>
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-red-900"
                onPress={() =>
                  Alert.alert(
                    "Rotate feed token?",
                    "Old subscription URLs stop working immediately.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Rotate",
                        style: "destructive",
                        onPress: () =>
                          void rotateFeed
                            .mutateAsync()
                            .then(() =>
                              toast.show({
                                variant: "success",
                                label: "Feed rotated — re-add the URL in your calendar app.",
                              }),
                            )
                            .catch((err: unknown) =>
                              toast.show({
                                variant: "danger",
                                label: err instanceof Error ? err.message : "Could not rotate.",
                              }),
                            ),
                      },
                    ],
                  )
                }
              >
                <Button.Label className="text-red-400">Rotate token</Button.Label>
              </Button>
            </View>
          </View>

          <View className="gap-1.5">
            <Text className="text-white text-sm font-semibold">Webhook signing secret</Text>
            <Text className="text-neutral-500 text-xs">
              Verify callbackUrl webhooks: HMAC-SHA256(secret, ts + "." + body) against the
              X-QuickCal-Signature header.
            </Text>
            <Text className="text-neutral-300 text-xs" selectable>
              {me.data?.webhookSecret ?? "…"}
            </Text>
            <Button
              size="sm"
              variant="outline"
              onPress={() => {
                void Clipboard.setStringAsync(me.data?.webhookSecret ?? "");
                toast.show({ variant: "success", label: "Webhook secret copied." });
              }}
            >
              <Button.Label>Copy secret</Button.Label>
            </Button>
          </View>

          <View className="gap-1.5">
            <Text className="text-white text-sm font-semibold">MCP server</Text>
            <Text className="text-neutral-500 text-xs">
              Use QuickCalAI from any MCP client — auth with your qc_… API key:
            </Text>
            <Text className="text-neutral-300 text-xs" selectable>
              {api.serverUrl()}/mcp
            </Text>
          </View>
        </SectionCard>

        <SectionCard title="Appearance">
          <View className="flex-row items-center justify-between">
            <Text className="text-neutral-400 text-sm">Light / dark theme</Text>
            <ThemeToggle />
          </View>
        </SectionCard>

        <SectionCard title="Session">
          <Button
            variant="outline"
            className="border-red-900"
            onPress={() => {
              void authClient.signOut();
            }}
          >
            <Button.Label className="text-red-400">Sign Out</Button.Label>
          </Button>
        </SectionCard>
      </View>
    </Container>
  );
}
