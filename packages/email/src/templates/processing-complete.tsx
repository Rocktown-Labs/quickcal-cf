import { Button } from "@react-email/button";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import { EmailShell } from "../components/email-shell";

export interface ProcessingCompleteEmailProps {
  fileName: string;
  eventCount: number;
  shareUrl?: string;
  icsUrl?: string;
}

function httpUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
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
  margin: "0 0 16px",
} as const;

const primaryButtonStyle = {
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

const secondaryButtonStyle = {
  display: "block",
  boxSizing: "border-box",
  background: "#212121",
  border: "1px solid #333333",
  color: "#efefef",
  fontWeight: "bold",
  padding: "12px 24px",
  borderRadius: "8px",
  textDecoration: "none",
  textAlign: "center",
} as const;

export function ProcessingCompleteEmail({
  fileName,
  eventCount,
  shareUrl,
  icsUrl,
}: ProcessingCompleteEmailProps) {
  const displayName =
    fileName
      .replace(/\.[^/.]+$/, "")
      .trim()
      .slice(0, 120) || "your upload";
  const eventWord = eventCount === 1 ? "event" : "events";
  const shareHref = httpUrl(shareUrl);
  const icsHref = httpUrl(icsUrl);

  return (
    <EmailShell preview={`Your calendar from ${displayName} is ready.`}>
      <Text style={headingStyle}>Your calendar is ready.</Text>

      <Text style={bodyStyle}>
        We found{" "}
        <strong style={{ color: "#efefef" }}>
          {eventCount} {eventWord}
        </strong>{" "}
        in <strong style={{ color: "#efefef" }}>{displayName}</strong>.
      </Text>

      {shareHref ? (
        <Section style={cardStyle}>
          <Text
            style={{
              color: "#efefef",
              fontSize: "16px",
              fontWeight: "bold",
              margin: "0 0 8px",
            }}
          >
            Share with your team
          </Text>
          <Text
            style={{
              color: "#888888",
              fontSize: "14px",
              lineHeight: "1.6",
              margin: "0 0 12px",
            }}
          >
            Send this link so others can view and download the calendar without signing up.
          </Text>
          <Button href={shareHref} style={primaryButtonStyle}>
            View shared schedule
          </Button>
        </Section>
      ) : null}

      {icsHref ? (
        <>
          <Button href={icsHref} style={{ ...secondaryButtonStyle, marginBottom: "24px" }}>
            Download .ics file
          </Button>
          <Text
            style={{
              color: "#888888",
              fontSize: "14px",
              lineHeight: "1.6",
              margin: 0,
            }}
          >
            Import the .ics file into Google Calendar, Outlook, Apple Calendar, or any app that
            supports calendar files.
          </Text>
        </>
      ) : null}
    </EmailShell>
  );
}

ProcessingCompleteEmail.PreviewProps = {
  fileName: "Fall Basketball Schedule.pdf",
  eventCount: 12,
  shareUrl: "https://quickcalai.com/s/example",
  icsUrl: "https://example.com/api/share/example/ics",
} satisfies ProcessingCompleteEmailProps;
