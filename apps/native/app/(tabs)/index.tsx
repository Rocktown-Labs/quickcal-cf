import { useState } from "react";
import { Text, View } from "react-native";
import { Button, useToast } from "heroui-native";
import { authClient } from "@/lib/auth-client";
import { useMe, useStats } from "@/lib/queries";
import { Uploader } from "@/components/uploader";
import { Container } from "@/components/container";

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View className="flex-1 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <Text className="text-sm text-neutral-400 mb-1">{label}</Text>
      <Text className="text-2xl font-bold text-white">{value}</Text>
      {sub ? <Text className="text-xs text-neutral-500 mt-1">{sub}</Text> : null}
    </View>
  );
}

export default function DashboardScreen() {
  const { data: session } = authClient.useSession();
  const me = useMe();
  const stats = useStats();
  const { toast } = useToast();
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  const firstName =
    session?.user?.name?.split(" ")[0] || session?.user?.email?.split("@")[0] || "there";
  const isVerified = session?.user?.emailVerified ?? true;

  const totals = stats.data;
  const successRate =
    totals && totals.totalUploads > 0
      ? `${Math.round((totals.completedUploads / totals.totalUploads) * 100)}%`
      : "0%";

  async function resendVerification() {
    if (!session?.user?.email) return;
    setResendState("sending");
    const { error } = await authClient.sendVerificationEmail({
      email: session.user.email,
      callbackURL: "/",
    });
    setResendState(error ? "idle" : "sent");
    toast.show({
      variant: error ? "danger" : "success",
      label: error ? "Couldn't send — try again" : "Sent! Check your inbox",
    });
  }

  return (
    <Container className="bg-neutral-950">
      <View className="px-4 pt-6 pb-4 flex-row items-center justify-between">
        <View>
          <Text className="text-2xl font-bold text-white">Welcome back, {firstName}!</Text>
          <Text className="text-neutral-400 mt-1">
            Ready to extract calendar events from your images?
          </Text>
        </View>
      </View>

      {!isVerified ? (
        <View className="mx-4 mb-4 rounded-xl border border-amber-800 bg-amber-950/30 p-4 gap-3">
          <Text className="text-amber-200 text-sm flex-1">
            Please verify your email to secure your account and enable password recovery.
          </Text>
          <Button
            size="sm"
            className="bg-amber-700"
            onPress={() => void resendVerification()}
            isDisabled={resendState === "sending"}
          >
            <Button.Label>
              {resendState === "sending"
                ? "Sending…"
                : resendState === "sent"
                  ? "Sent ✓"
                  : "Resend verification email"}
            </Button.Label>
          </Button>
        </View>
      ) : null}

      <View className="flex-row gap-3 px-4">
        <StatCard
          label="Total Uploads"
          value={totals ? String(totals.totalUploads) : "–"}
          sub={totals ? `${totals.completedUploads} processed` : undefined}
        />
        <StatCard label="Events Extracted" value={totals ? String(totals.totalEvents) : "–"} />
      </View>
      <View className="flex-row gap-3 px-4 mt-3">
        <View className="flex-1">
          <StatCard label="Success Rate" value={successRate} />
        </View>
      </View>

      <View className="px-4 mt-6">
        <Uploader />
      </View>

      {totals && totals.recentUploads.length > 0 ? (
        <View className="px-4 mt-8 mb-10 gap-2">
          <Text className="text-2xl font-bold text-white mb-1">Recent Activity</Text>
          {totals.recentUploads.map((u) => (
            <View
              key={u.id}
              className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 flex-row items-center gap-3"
            >
              <Text className="text-2xl">🖼</Text>
              <View className="flex-1">
                <Text className="text-white text-sm font-medium" numberOfLines={1}>
                  {u.fileName}
                </Text>
                <Text className="text-neutral-500 text-xs">
                  {new Date(u.createdAt).toLocaleDateString()} • {u.status.replace("_", " ")}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </Container>
  );
}
