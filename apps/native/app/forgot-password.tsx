import { Link } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button, Input, Label, Spinner, TextField, useToast } from "heroui-native";
import { authClient } from "@/lib/auth-client";
import { AuthShell } from "@/components/auth-shell";

export default function ForgotPasswordScreen() {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit() {
    const value = email.trim();
    if (!value) {
      toast.show({ variant: "danger", label: "Enter your account email first." });
      return;
    }
    setPending(true);
    const { error } = await authClient.requestPasswordReset({ email: value });
    setPending(false);
    if (error) {
      toast.show({ variant: "danger", label: error.message || "Could not send the reset email." });
      return;
    }
    setSent(true);
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your account email and we'll send you a reset link."
      footer={
        <Link href="/login" className="text-[#c23326] text-sm font-semibold">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <View className="items-center py-4 gap-3">
          <Text className="text-4xl">📬</Text>
          <Text className="font-semibold text-white">Check your inbox</Text>
          <Text className="text-center text-neutral-400 text-sm">
            If an account exists for that email, a reset link is on its way. The link expires in 1
            hour.
          </Text>
        </View>
      ) : (
        <View className="gap-4">
          <TextField>
            <Label>Email</Label>
            <Input
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              textContentType="emailAddress"
            />
          </TextField>
          <Button onPress={() => void submit()} isDisabled={pending} className="mt-1 bg-[#c23326]">
            {pending ? (
              <Spinner size="sm" color="default" />
            ) : (
              <Button.Label>Send reset link</Button.Label>
            )}
          </Button>
        </View>
      )}
    </AuthShell>
  );
}
