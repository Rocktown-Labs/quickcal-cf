import { Button } from "@react-email/button";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import { EmailShell } from "../components/email-shell";

export interface WelcomeEmailProps {
  name?: string;
  dashboardUrl: string;
  freeCredits?: number;
}

const headingStyle = {
  color: "#efefef",
  fontSize: "20px",
  fontWeight: "bold",
  margin: "0 0 16px",
} as const;

const bodyStyle = {
  color: "#888888",
  fontSize: "16px",
  lineHeight: "1.6",
  margin: "0 0 24px",
} as const;

const cardStyle = {
  background: "#1a1a1a",
  borderRadius: "8px",
  padding: "20px",
  margin: "0 0 24px",
} as const;

const buttonStyle = {
  display: "block",
  boxSizing: "border-box",
  background: "#c23326",
  color: "#ffffff",
  fontWeight: "bold",
  padding: "12px 24px",
  borderRadius: "8px",
  textDecoration: "none",
  textAlign: "center",
} as const;

export function WelcomeEmail({ name, dashboardUrl, freeCredits = 1 }: WelcomeEmailProps) {
  const firstName = name?.trim().split(/\s+/)[0];
  const creditLine =
    freeCredits > 0
      ? `You have ${freeCredits} free AI extraction${freeCredits === 1 ? "" : "s"}.`
      : "Your free AI extraction has been used.";

  return (
    <EmailShell preview="Welcome to QuickCalAI. Your first calendar is one upload away.">
      <Text style={headingStyle}>Welcome aboard{firstName ? `, ${firstName}` : ""}.</Text>

      <Text style={bodyStyle}>
        QuickCalAI turns a schedule photo, PDF, pasted text, or public URL into calendar events you
        can import anywhere.
      </Text>

      <Section style={cardStyle}>
        <Text
          style={{
            color: "#efefef",
            fontSize: "16px",
            fontWeight: "bold",
            margin: "0 0 8px",
          }}
        >
          How it works
        </Text>
        <Text
          style={{
            color: "#888888",
            fontSize: "14px",
            lineHeight: "1.6",
            margin: 0,
          }}
        >
          1. Upload a file, paste the schedule, or drop in a public URL.
          <br />
          2. AI reads the dates, times, and event names.
          <br />
          3. Download the .ics, email it, or share a link.
        </Text>
      </Section>

      <Text style={bodyStyle}>{creditLine} Manual events are free forever.</Text>

      <Button href={dashboardUrl} style={buttonStyle}>
        Upload your first schedule
      </Button>

      <Text
        style={{
          color: "#888888",
          fontSize: "14px",
          lineHeight: "1.6",
          margin: "24px 0 0",
        }}
      >
        Questions? Reply to this email. We read every one.
      </Text>
    </EmailShell>
  );
}

WelcomeEmail.PreviewProps = {
  name: "John",
  dashboardUrl: "https://quickcalai.com/dashboard",
  freeCredits: 1,
} satisfies WelcomeEmailProps;
