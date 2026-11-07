import { Button } from "@react-email/button";
import { Link } from "@react-email/link";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import { EmailShell } from "../components/email-shell";

export interface AnnouncementEmailProps {
  firstName?: string;
  senderName?: string;
  loginUrl: string;
  unsubscribeUrl: string;
  mailingAddress?: string;
}

export const ANNOUNCEMENT_SUBJECT = "QuickCalAI is rebuilt, and it is agent-ready";
export const ANNOUNCEMENT_PREVIEW =
  "Paste text, drop a link, or connect Claude or Cursor. One free AI extraction is waiting.";

const bodyStyle = {
  color: "#888888",
  fontSize: "16px",
  lineHeight: "1.6",
  margin: "0 0 16px",
} as const;

const cardStyle = {
  background: "#1a1a1a",
  borderRadius: "8px",
  padding: "20px",
  margin: "0 0 24px",
} as const;

const bulletStyle = {
  color: "#efefef",
  fontSize: "14px",
  lineHeight: "1.6",
  margin: "0 0 12px",
} as const;

const lastBulletStyle = {
  ...bulletStyle,
  margin: 0,
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

export function AnnouncementEmail({
  firstName,
  senderName,
  loginUrl,
  unsubscribeUrl,
  mailingAddress,
}: AnnouncementEmailProps) {
  const greeting = firstName?.trim() ? `Hey ${firstName.trim()},` : "Hey there,";
  const signOff = senderName?.trim() || "The QuickCalAI team";

  return (
    <EmailShell
      preview={ANNOUNCEMENT_PREVIEW}
      footer={
        <>
          <Text
            style={{
              color: "#666666",
              fontSize: "12px",
              lineHeight: "1.6",
              textAlign: "center",
              margin: 0,
            }}
          >
            You are receiving this because you have a QuickCalAI account.{" "}
            <Link href={unsubscribeUrl} style={{ color: "#888888", textDecoration: "underline" }}>
              Unsubscribe
            </Link>
            .
          </Text>
          <Text
            style={{
              color: "#666666",
              fontSize: "12px",
              textAlign: "center",
              margin: "8px 0 0",
            }}
          >
            Rocktown Labs{mailingAddress ? `, ${mailingAddress}` : ""}
          </Text>
        </>
      }
    >
      <Text
        style={{
          color: "#efefef",
          fontSize: "20px",
          fontWeight: "bold",
          margin: "0 0 16px",
        }}
      >
        {greeting}
      </Text>

      <Text style={bodyStyle}>
        You have a QuickCalAI account, so I wanted you to hear it from me: we rebuilt the app from
        the ground up. Not a patch. A new engine, new infrastructure, and features that were not
        possible in the old version.
      </Text>

      <Text style={bodyStyle}>Here is what is new:</Text>

      <Section style={cardStyle}>
        <Text style={bulletStyle}>
          <strong style={{ color: "#c23326" }}>More ways in.</strong> Photos and PDFs still work.
          You can now paste schedule text, drop a public URL, or send structured JSON.
        </Text>
        <Text style={bulletStyle}>
          <strong style={{ color: "#c23326" }}>Agent-ready.</strong> Connect QuickCalAI to Claude,
          Cursor, or any MCP client. Or use the REST API with a qc_... key. An agent can create
          events, check processing status, fix a misread event, and revoke a share link.
        </Text>
        <Text style={bulletStyle}>
          <strong style={{ color: "#c23326" }}>Review, do not guess.</strong> Every AI-extracted
          event includes a confidence score and the exact source quote it came from. Edit one event
          and the .ics regenerates immediately.
        </Text>
        <Text style={bulletStyle}>
          <strong style={{ color: "#c23326" }}>One feed for everything.</strong> Subscribe once to a
          private calendar URL that contains every event you own. Rotate the URL whenever you want.
        </Text>
        <Text style={bulletStyle}>
          <strong style={{ color: "#c23326" }}>A sturdier pipeline.</strong> Failures are handled
          instead of leaving an upload spinning.
        </Text>
        <Text style={lastBulletStyle}>
          <strong style={{ color: "#c23326" }}>Free to start.</strong> Every account gets one free
          AI extraction. Manual events are free forever. Premium is $12.99 per month or $71.88 per
          year for unlimited AI.
        </Text>
      </Section>

      <Text
        style={{
          color: "#efefef",
          fontSize: "16px",
          fontWeight: "bold",
          margin: "0 0 8px",
        }}
      >
        How to get in
      </Text>
      <Text
        style={{
          color: "#888888",
          fontSize: "14px",
          lineHeight: "1.6",
          margin: "0 0 24px",
        }}
      >
        1. Go to {loginUrl}
        <br />
        2. If you used Google before, continue with Google.
        <br />
        3. If you used a password, choose &quot;Forgot password&quot; once to set a new one.
        Passwords cannot move between auth providers. Security thing, not a you thing.
      </Text>

      <Button href={loginUrl} style={buttonStyle}>
        Open the new QuickCalAI
      </Button>

      <Text
        style={{
          color: "#888888",
          fontSize: "14px",
          lineHeight: "1.6",
          margin: "24px 0 0",
        }}
      >
        If something looks off, reply. I read every one.
      </Text>

      <Text
        style={{
          color: "#888888",
          fontSize: "14px",
          lineHeight: "1.6",
          margin: "16px 0 0",
        }}
      >
        {signOff}
      </Text>

      <Text
        style={{
          color: "#888888",
          fontSize: "14px",
          lineHeight: "1.6",
          margin: "16px 0 0",
        }}
      >
        P.S. The old version had rough edges. This one is a rebuild, not a coat of paint.
      </Text>
    </EmailShell>
  );
}

AnnouncementEmail.PreviewProps = {
  firstName: "John",
  senderName: "Rocktown Labs",
  loginUrl: "https://quickcalai.com/login",
  unsubscribeUrl: "mailto:unsubscribe@quickcalai.com?subject=Unsubscribe",
  mailingAddress: "123 Main St, City, State 00000",
} satisfies AnnouncementEmailProps;
