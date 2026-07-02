// Real outbound email delivery for the outreach module, accessed through the
// Replit Connectors proxy (Resend). The proxy injects authentication, so no API
// key lives in this codebase. Integration: connector `resend` (see the
// integrations skill).
//
// This module is the ONLY place that talks to a live email provider. The send
// handler in routes/messages.ts calls isEmailProviderConfigured() first and
// falls back to the simulated delivery note when no provider is connected, so
// hosted/dev/test behavior is unchanged until the shop owner connects a
// provider. Desktop can also use direct SMTP (including Gmail app passwords).
import { ReplitConnectors } from "@replit/connectors-sdk";
import nodemailer from "nodemailer";

// Connector name as registered with the Replit Connectors proxy.
export const RESEND_CONNECTOR = "resend";

export class EmailError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "EmailError";
    this.status = status;
  }
}

type EmailProvider = "resend" | "smtp";

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

// Never cache the client — the SDK refreshes tokens internally per call.
function client(): ReplitConnectors {
  return new ReplitConnectors();
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function parsePort(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return null;
  return n;
}

function parseSecure(raw: string | undefined, port: number): boolean {
  if (!raw) return port === 465;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return port === 465;
}

// SMTP config (desktop-friendly):
// - Generic: OUTREACH_SMTP_HOST/PORT/SECURE/USER/PASS
// - Gmail convenience: GMAIL_SMTP_USER + GMAIL_SMTP_APP_PASSWORD
function getSmtpConfig(): SmtpConfig | null {
  const gmailUser = process.env.GMAIL_SMTP_USER?.trim() || "";
  const gmailPass = process.env.GMAIL_SMTP_APP_PASSWORD?.trim() || "";
  const user = process.env.OUTREACH_SMTP_USER?.trim() || gmailUser;
  const pass = process.env.OUTREACH_SMTP_PASS?.trim() || gmailPass;
  if (!user || !pass) return null;

  const explicitHost = process.env.OUTREACH_SMTP_HOST?.trim();
  const host = explicitHost || (gmailUser ? "smtp.gmail.com" : "");
  if (!host) return null;

  const port =
    parsePort(process.env.OUTREACH_SMTP_PORT) ?? (host === "smtp.gmail.com" ? 465 : 587);
  const secure = parseSecure(process.env.OUTREACH_SMTP_SECURE, port);

  return { host, port, secure, user, pass };
}

async function hasResendConnection(): Promise<boolean> {
  if (!process.env.REPLIT_CONNECTORS_HOSTNAME) return false;
  try {
    const connections = await client().listConnections({
      connector_names: RESEND_CONNECTOR,
    });
    return connections.length > 0;
  } catch {
    return false;
  }
}

// Returns true if a Resend integration is connected to this workspace. When the
// connectors proxy environment is absent (e.g. the in-process test suite) or no
// connection is bound, this returns false so the caller simulates instead of
// attempting a live send. Never throws.
export async function isEmailProviderConfigured(): Promise<boolean> {
  if (getSmtpConfig()) return true;
  return hasResendConnection();
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendEmailInput {
  to: string;
  toName?: string | null;
  from: string;
  fromName?: string | null;
  subject: string;
  body: string;
  attachments?: EmailAttachment[];
}

export interface SendEmailResult {
  id: string;
  provider: EmailProvider;
}

// Format an address as `Name <email>` when a display name is present, otherwise
// the bare address. Resend accepts either form.
function formatAddress(email: string, name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? `${trimmed} <${email}>` : email;
}

// Deliver one email (optionally with attachments) via Resend. Returns the
// provider message id on success. Throws EmailError on any failure so the caller
// can surface a 502 and leave the message retryable rather than marking it sent.
async function sendViaResend(input: SendEmailInput): Promise<SendEmailResult> {
  const payload: Record<string, unknown> = {
    from: formatAddress(input.from, input.fromName),
    to: [formatAddress(input.to, input.toName)],
    subject: input.subject,
    text: input.body,
  };
  if (input.attachments && input.attachments.length > 0) {
    payload.attachments = input.attachments.map((a) => ({
      filename: a.filename,
      content: a.content.toString("base64"),
      ...(a.contentType ? { content_type: a.contentType } : {}),
    }));
  }

  let resp: Response;
  try {
    resp = await client().proxy(RESEND_CONNECTOR, "/emails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new EmailError(`Email request failed: ${(err as Error).message}`);
  }
  if (!isOk(resp.status)) {
    const detail = await resp.text().catch(() => "");
    throw new EmailError(
      `Email provider returned ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const data = (await resp.json().catch(() => ({}))) as { id?: unknown };
  return { id: typeof data.id === "string" ? data.id : "", provider: "resend" };
}

async function sendViaSmtp(input: SendEmailInput, cfg: SmtpConfig): Promise<SendEmailResult> {
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  });

  try {
    const info = await transporter.sendMail({
      from: formatAddress(input.from, input.fromName),
      to: formatAddress(input.to, input.toName),
      subject: input.subject,
      text: input.body,
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        ...(a.contentType ? { contentType: a.contentType } : {}),
      })),
    });
    return { id: info.messageId ?? "", provider: "smtp" };
  } catch (err) {
    throw new EmailError(`SMTP delivery failed: ${(err as Error).message}`);
  }
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const resendConnected = await hasResendConnection();
  if (resendConnected) return sendViaResend(input);

  const smtp = getSmtpConfig();
  if (smtp) return sendViaSmtp(input, smtp);

  throw new EmailError(
    "No email provider configured. Connect Resend or set OUTREACH_SMTP_* (or GMAIL_SMTP_USER/GMAIL_SMTP_APP_PASSWORD).",
    409,
  );
}
