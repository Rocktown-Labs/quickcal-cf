import { Link, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button, FieldError, Input, Label, Spinner, TextField, useToast } from "heroui-native";
import { authClient } from "@/lib/auth-client";
import { AuthShell } from "@/components/auth-shell";

export default function ResetPasswordScreen() {
  const { toast } = useToast();
  const params = useLocalSearchParams<{ token?: string; email?: string }>();
  const token = typeof params.token === "string" ? params.token : "";
  const email = typeof params.email === "string" ? params.email : "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setPending(true);
    const { error: apiError } = await authClient.resetPassword({
      newPassword: password,
      token,
    });
    setPending(false);
    if (apiError) {
      setError(apiError.message || "This reset link may have expired. Request a new one.");
      return;
    }
    setDone(true);
    toast.show({ variant: "success", label: "Password updated" });
  }

  const missing = !token || !email;

  return (
    <AuthShell
      title="Choose a new password"
      subtitle={missing ? undefined : `Setting a new password for ${email}`}
      footer={
        <Link href="/login" className="text-[#c23326] text-sm font-semibold">
          Back to sign in
        </Link>
      }
    >
      {missing ? (
        <View className="items-center py-4 gap-3">
          <Text className="text-4xl">🔗</Text>
          <Text className="font-semibold text-white">This link isn't complete</Text>
          <Text className="text-center text-neutral-400 text-sm">
            Reset links come from the email we send you and can only be used once.
          </Text>
        </View>
      ) : done ? (
        <View className="items-center py-4 gap-3">
          <Text className="text-4xl">✅</Text>
          <Text className="font-semibold text-white">Password updated</Text>
          <Text className="text-center text-neutral-400 text-sm">
            Your new password is active. Sign in to continue.
          </Text>
        </View>
      ) : (
        <View className="gap-4">
          <TextField>
            <Label>New password</Label>
            <Input
              value={password}
              onChangeText={setPassword}
              placeholder="At least 8 characters"
              secureTextEntry
              autoComplete="password-new"
              textContentType="newPassword"
            />
          </TextField>
          <TextField>
            <Label>Confirm password</Label>
            <Input
              value={confirm}
              onChangeText={setConfirm}
              placeholder="Repeat your new password"
              secureTextEntry
              autoComplete="password-new"
              textContentType="newPassword"
            />
            <FieldError isInvalid={error !== null}>{error}</FieldError>
          </TextField>
          <Button onPress={() => void submit()} isDisabled={pending} className="mt-1 bg-[#c23326]">
            {pending ? (
              <Spinner size="sm" color="default" />
            ) : (
              <Button.Label>Update password</Button.Label>
            )}
          </Button>
        </View>
      )}
    </AuthShell>
  );
}
