/** Shared email palette and typography so templates cannot drift. */
export const EMAIL_COLORS = {
  page: "#0a0a0a",
  card: "#161616",
  raised: "#1a1a1a",
  brand: "#c23326",
  foreground: "#efefef",
  muted: "#888888",
  faint: "#666666",
  border: "#333333",
} as const;

export const headingStyle = {
  color: EMAIL_COLORS.foreground,
  fontSize: "20px",
  fontWeight: "bold",
  margin: "0 0 16px",
} as const;

export const bodyStyle = {
  color: EMAIL_COLORS.muted,
  fontSize: "16px",
  lineHeight: "1.6",
  margin: "0 0 16px",
} as const;

export const smallTextStyle = {
  color: EMAIL_COLORS.muted,
  fontSize: "14px",
  lineHeight: "1.6",
  margin: 0,
} as const;

export const cardStyle = {
  background: EMAIL_COLORS.raised,
  borderRadius: "8px",
  padding: "20px",
  margin: "0 0 24px",
} as const;

export const primaryButtonStyle = {
  display: "block",
  boxSizing: "border-box",
  background: EMAIL_COLORS.brand,
  color: "#ffffff",
  fontWeight: "bold",
  padding: "12px 24px",
  borderRadius: "8px",
  textDecoration: "none",
  textAlign: "center",
} as const;

export const secondaryButtonStyle = {
  display: "inline-block",
  background: EMAIL_COLORS.raised,
  color: EMAIL_COLORS.foreground,
  fontWeight: "bold",
  padding: "12px 24px",
  borderRadius: "8px",
  textDecoration: "none",
  textAlign: "center",
} as const;
