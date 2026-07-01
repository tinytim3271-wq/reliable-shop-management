// Real outbound email delivery for the outreach module, accessed through the
// Replit Connectors proxy (Resend). The proxy injects authentication, so no API
// key lives in this codebase. Integration: connector `resend` (see the
// integrations skill).
//
// This module is the ONLY place that talks to a live email provider. The send
// handler in routes/messages.ts calls isEmailProviderConfigured() first and
// falls back to the simulated delivery note when no provider is connected, so
// hosted/dev/test behavior is unchanged until the shop owner connects Resend.
import { ReplitConnectors } from "@replit/connectors-sdk";

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

// Never cache the client — the SDK refreshes tokens internally per call.
function client(): ReplitConnectors {
  return new ReplitConnectors();
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

// Returns true if a Resend integration is connected to this workspace. When the
// connectors proxy environment is absent (e.g. the in-process test suite) or no
// connection is bound, this returns false so the caller simulates instead of
// attempting a live send. Never throws.
export async function isEmailProviderConfigured(): Promise<boolean> {
  if (!process.env.REPLIT_CONNECTORS_HOSTNAME) return false;
  try {
    const connections = await client().listConnections({
      connector_names: RESEND_CONNECTOR,
    });
    // The proxy only returns connections bound to this workspace, so any
    // returned connection means a usable provider is configured.
    return connections.length > 0;
  } catch {
    return false;
  }
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

// Format an address as `Name <email>` when a display name is present, otherwise
// the bare address. Resend accepts either form.
function formatAddress(email: string, name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? `${trimmed} <${email}>` : email;
}

// Deliver one email (optionally with attachments) via Resend. Returns the
// provider message id on success. Throws EmailError on any failure so the caller
// can surface a 502 and leave the message retryable rather than marking it sent.
export async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
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
  return { id: typeof data.id === "string" ? data.id : "" };
}
