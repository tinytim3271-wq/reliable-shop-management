import { Router, type IRouter } from "express";
import { eq, and, desc, inArray, isNull, isNotNull, type SQL } from "drizzle-orm";
import { db, messagesTable, shopSettingsTable } from "@workspace/db";
import {
  ListMessagesResponse,
  ListMessagesQueryParams,
  CreateMessageBody,
  CreateMessagesBulkBody,
  MarkMessagesReadBody,
  MarkMessagesReadResponse,
  GetMessageParams,
  GetMessageResponse,
  UpdateMessageParams,
  UpdateMessageBody,
  UpdateMessageResponse,
  DeleteMessageParams,
  ApproveMessageParams,
  ApproveMessageResponse,
  SendMessageParams,
  SendMessageResponse,
  CancelMessageParams,
  CancelMessageResponse,
  AcknowledgeMessageParams,
  AcknowledgeMessageResponse,
} from "@workspace/api-zod";
import {
  resolveRecipient,
  SIMULATED_DELIVERY_NOTE,
  getSmsConsentStatus,
} from "../lib/messaging";
import {
  isEmailProviderConfigured,
  sendEmail,
  EmailError,
  type EmailAttachment,
} from "../lib/email";
import { isSmsProviderConfigured, sendSms, SmsError } from "../lib/sms";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();

router.get("/messages", async (req, res): Promise<void> => {
  const q = ListMessagesQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }

  const filters: SQL[] = [];
  if (q.data.status) filters.push(eq(messagesTable.status, q.data.status));
  if (q.data.direction) filters.push(eq(messagesTable.direction, q.data.direction));
  if (q.data.channel) filters.push(eq(messagesTable.channel, q.data.channel));
  if (q.data.category) filters.push(eq(messagesTable.category, q.data.category));
  if (q.data.audience) filters.push(eq(messagesTable.audience, q.data.audience));
  if (q.data.customerId) filters.push(eq(messagesTable.customerId, q.data.customerId));

  const rows = await db
    .select()
    .from(messagesTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(messagesTable.createdAt));

  res.json(ListMessagesResponse.parse(rows));
});

router.post("/messages", async (req, res): Promise<void> => {
  const parsed = CreateMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const d = parsed.data;
  const { toName, toAddress } = await resolveRecipient({
    channel: d.channel,
    customerId: d.customerId ?? null,
    vendorId: d.vendorId ?? null,
    toName: d.toName ?? null,
    toAddress: d.toAddress ?? null,
  });

  const [created] = await db
    .insert(messagesTable)
    .values({
      channel: d.channel,
      category: d.category ?? "other",
      audience: d.audience ?? "customer",
      customerId: d.customerId ?? null,
      vendorId: d.vendorId ?? null,
      toName,
      toAddress,
      subject: d.subject ?? null,
      body: d.body,
      attachmentPath: d.attachmentPath ?? null,
      attachmentName: d.attachmentName ?? null,
      attachmentMimeType: d.attachmentMimeType ?? null,
      status: "draft",
      source: "staff",
      createdByUserId: req.currentUser!.id,
    })
    .returning();

  res.status(201).json(UpdateMessageResponse.parse(created));
});

// Bulk create (marketing blast): one row per recipient, all sharing a batchId so
// the outbox can group them. Every row is still created as a draft and must be
// approved + sent individually (or in a future bulk-approve step).
// For SMS campaigns, recipients who have explicitly revoked consent (replied STOP)
// are skipped — no draft is created for them. The response reports how many drafts
// were created, how many were skipped due to opt-out, and how many failed to resolve.
router.post("/messages/bulk", async (req, res): Promise<void> => {
  const parsed = CreateMessagesBulkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const d = parsed.data;
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  type RecipientOutcome =
    | { kind: "ok"; row: typeof messagesTable.$inferInsert }
    | { kind: "skipped_opt_out" }
    | { kind: "failed" };

  const outcomes = await Promise.all(
    d.recipients.map(async (r): Promise<RecipientOutcome> => {
      try {
        const { toName, toAddress } = await resolveRecipient({
          channel: d.channel,
          customerId: r.customerId ?? null,
          vendorId: r.vendorId ?? null,
          toName: r.toName ?? null,
          toAddress: r.toAddress ?? null,
        });

        // Gate opted-out SMS numbers: skip creating a draft if the recipient has
        // explicitly revoked consent (replied STOP). Only an explicit "revoked"
        // blocks — numbers with no record on file are allowed through.
        if (d.channel === "sms") {
          const consent = await getSmsConsentStatus(toAddress);
          if (consent === "revoked") {
            req.log.info(
              { toAddress, batchId },
              "bulk create: skipped opted-out SMS recipient",
            );
            return { kind: "skipped_opt_out" };
          }
        }

        return {
          kind: "ok",
          row: {
            channel: d.channel,
            category: d.category ?? "marketing",
            audience: d.audience ?? "customer",
            customerId: r.customerId ?? null,
            vendorId: r.vendorId ?? null,
            toName,
            toAddress,
            subject: d.subject ?? null,
            body: d.body,
            status: "draft",
            source: "staff",
            batchId,
            createdByUserId: req.currentUser!.id,
          },
        };
      } catch (err) {
        req.log.warn(
          { err, recipient: r, batchId },
          "bulk create: failed to resolve recipient",
        );
        return { kind: "failed" };
      }
    }),
  );

  const rows = outcomes
    .filter((o): o is { kind: "ok"; row: typeof messagesTable.$inferInsert } => o.kind === "ok")
    .map((o) => o.row);
  const skippedOptOut = outcomes.filter((o) => o.kind === "skipped_opt_out").length;
  const failed = outcomes.filter((o) => o.kind === "failed").length;

  const created = rows.length > 0
    ? await db.insert(messagesTable).values(rows).returning()
    : [];

  res.status(201).json({
    messages: ListMessagesResponse.parse(created),
    skippedOptOut,
    failed,
  });
});

// Mark inbound customer replies as read (e.g. when staff open a thread). Only
// inbound rows that are still unread are stamped, so outbound messages and
// already-read rows are left untouched and the call is idempotent. Registered
// before "/messages/:id" so the literal path is matched first.
router.post("/messages/mark-read", async (req, res): Promise<void> => {
  const parsed = MarkMessagesReadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updated = await db
    .update(messagesTable)
    .set({ readAt: new Date().toISOString() })
    .where(
      and(
        inArray(messagesTable.id, parsed.data.ids),
        eq(messagesTable.direction, "inbound"),
        isNull(messagesTable.readAt),
      ),
    )
    .returning();

  res.json(MarkMessagesReadResponse.parse(updated));
});

// Mark inbound customer replies as unread again (e.g. when staff open a thread
// but want it to resurface in the unread count to deal with later). Only inbound
// rows that are currently read are cleared, so outbound messages and rows that
// are already unread are left untouched and the call is idempotent. Registered
// before "/messages/:id" so the literal path is matched first.
router.post("/messages/mark-unread", async (req, res): Promise<void> => {
  const parsed = MarkMessagesReadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updated = await db
    .update(messagesTable)
    .set({ readAt: null })
    .where(
      and(
        inArray(messagesTable.id, parsed.data.ids),
        eq(messagesTable.direction, "inbound"),
        isNotNull(messagesTable.readAt),
      ),
    )
    .returning();

  res.json(MarkMessagesReadResponse.parse(updated));
});

router.get("/messages/:id", async (req, res): Promise<void> => {
  const params = GetMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [message] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, params.data.id));
  if (!message) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  res.json(GetMessageResponse.parse(message));
});

router.patch("/messages/:id", async (req, res): Promise<void> => {
  const params = UpdateMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  // Only drafts are editable; once approved/sent the content is locked.
  if (existing.status !== "draft") {
    res
      .status(409)
      .json({ error: "Only draft messages can be edited." });
    return;
  }

  const d = parsed.data;
  // Re-resolve the recipient if any addressing field changed.
  const channel = d.channel ?? existing.channel;
  const recipientChanged =
    d.customerId !== undefined ||
    d.vendorId !== undefined ||
    d.toName !== undefined ||
    d.toAddress !== undefined ||
    d.channel !== undefined;
  let toName = existing.toName;
  let toAddress = existing.toAddress;
  if (recipientChanged) {
    const resolved = await resolveRecipient({
      channel,
      customerId:
        d.customerId !== undefined ? d.customerId : existing.customerId,
      vendorId: d.vendorId !== undefined ? d.vendorId : existing.vendorId,
      toName: d.toName !== undefined ? d.toName : existing.toName,
      toAddress: d.toAddress !== undefined ? d.toAddress : existing.toAddress,
    });
    toName = resolved.toName;
    toAddress = resolved.toAddress;
  }

  const [updated] = await db
    .update(messagesTable)
    .set({
      ...(d.channel !== undefined ? { channel: d.channel } : {}),
      ...(d.category !== undefined ? { category: d.category } : {}),
      ...(d.audience !== undefined ? { audience: d.audience } : {}),
      ...(d.customerId !== undefined ? { customerId: d.customerId } : {}),
      ...(d.vendorId !== undefined ? { vendorId: d.vendorId } : {}),
      ...(d.subject !== undefined ? { subject: d.subject } : {}),
      ...(d.body !== undefined ? { body: d.body } : {}),
      toName,
      toAddress,
    })
    .where(eq(messagesTable.id, params.data.id))
    .returning();

  res.json(UpdateMessageResponse.parse(updated));
});

router.post("/messages/:id/approve", async (req, res): Promise<void> => {
  const params = ApproveMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  if (existing.status !== "draft") {
    res
      .status(409)
      .json({ error: "Only draft messages can be approved." });
    return;
  }

  const [updated] = await db
    .update(messagesTable)
    .set({ status: "approved", approvedByUserId: req.currentUser!.id })
    .where(eq(messagesTable.id, params.data.id))
    .returning();

  res.json(ApproveMessageResponse.parse(updated));
});

router.post("/messages/:id/send", async (req, res): Promise<void> => {
  const params = SendMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  // Enforce the staff-approval gate: nothing sends until it is approved.
  if (existing.status !== "approved") {
    res
      .status(409)
      .json({ error: "A message must be approved before it can be sent." });
    return;
  }
  if (!existing.toAddress) {
    res.status(409).json({
      error: "Add a recipient address before sending this message.",
    });
    return;
  }

  // Decide whether to deliver for real or simulate. Email goes out via Resend
  // and SMS via Twilio, both through the connectors proxy. When the relevant
  // provider is not connected we fall back to the simulated delivery note so
  // hosted/dev/test behavior is unchanged.
  const useLiveEmail =
    existing.channel === "email" && (await isEmailProviderConfigured());
  const useLiveSms =
    existing.channel === "sms" && (await isSmsProviderConfigured());

  let deliveryNote = SIMULATED_DELIVERY_NOTE;

  // Honor SMS opt-out: never deliver a live text to a number that has revoked
  // consent (replied STOP). Only an explicit "revoked" blocks; numbers without a
  // consent record on file are unaffected so existing customers still receive
  // messages. Simulated sends are not gated.
  if (useLiveSms) {
    const consent = await getSmsConsentStatus(existing.toAddress);
    if (consent === "revoked") {
      res.status(409).json({
        error:
          "This number has opted out of text messages (replied STOP). It cannot receive SMS until they reply START to opt back in.",
      });
      return;
    }
  }

  if (useLiveSms) {
    try {
      const result = await sendSms({
        to: existing.toAddress,
        body: existing.body,
      });
      deliveryNote = result.id
        ? `Delivered via Twilio (sid: ${result.id}).`
        : "Delivered via Twilio.";
    } catch (err) {
      // Persist the failure reason so the outbox can surface it and staff know
      // to retry. Status stays "approved" so the Send button works as a retry.
      const errorMsg =
        err instanceof SmsError
          ? `SMS delivery failed: ${err.message}`
          : "SMS delivery failed. The message was not sent.";
      const failureNote = errorMsg;
      await db
        .update(messagesTable)
        .set({ deliveryNote: failureNote })
        .where(eq(messagesTable.id, params.data.id));
      const status = err instanceof SmsError ? err.status : 502;
      req.log.error(
        { err, messageId: existing.id },
        "outreach send: live SMS delivery failed",
      );
      res.status(status).json({ error: errorMsg });
      return;
    }
  } else if (useLiveEmail) {
    // Resolve the "from" address from shop settings, with an env override. A
    // live provider needs a verified sender, so refuse rather than silently
    // simulate when none is configured.
    const [settings] = await db
      .select({ email: shopSettingsTable.email, shopName: shopSettingsTable.shopName })
      .from(shopSettingsTable)
      .where(eq(shopSettingsTable.id, 1));
    const fromAddress =
      process.env.OUTREACH_FROM_EMAIL?.trim() || settings?.email?.trim() || null;
    if (!fromAddress) {
      res.status(409).json({
        error:
          "Set the shop email address in Settings (or OUTREACH_FROM_EMAIL) before sending real email.",
      });
      return;
    }

    // Load the attachment bytes (e.g. the report PDF Timothy attached) so they
    // can be relayed to the provider.
    let attachments: EmailAttachment[] | undefined;
    if (existing.attachmentPath) {
      try {
        const svc = new ObjectStorageService();
        const { bytes, contentType } = await svc.readObjectBytes(
          existing.attachmentPath,
        );
        attachments = [
          {
            filename: existing.attachmentName ?? "attachment",
            content: bytes,
            contentType: existing.attachmentMimeType ?? contentType,
          },
        ];
      } catch (err) {
        req.log.error(
          { err, messageId: existing.id, attachmentPath: existing.attachmentPath },
          "outreach send: failed to load attachment",
        );
        res.status(502).json({
          error: "Could not load the attachment for this message. Try again.",
        });
        return;
      }
    }

    try {
      const result = await sendEmail({
        to: existing.toAddress,
        toName: existing.toName,
        from: fromAddress,
        fromName: settings?.shopName ?? null,
        subject: existing.subject ?? "",
        body: existing.body,
        attachments,
      });
      deliveryNote = result.id
        ? `Delivered via Resend (id: ${result.id}).`
        : "Delivered via Resend.";
    } catch (err) {
      // Persist the failure reason so the outbox can surface it and staff know
      // to retry. Status stays "approved" so the Send button works as a retry.
      const errorMsg =
        err instanceof EmailError
          ? `Email delivery failed: ${err.message}`
          : "Email delivery failed. The message was not sent.";
      await db
        .update(messagesTable)
        .set({ deliveryNote: errorMsg })
        .where(eq(messagesTable.id, params.data.id));
      const status = err instanceof EmailError ? err.status : 502;
      req.log.error(
        { err, messageId: existing.id },
        "outreach send: live email delivery failed",
      );
      res.status(status).json({ error: errorMsg });
      return;
    }
  }

  const [updated] = await db
    .update(messagesTable)
    .set({
      status: "sent",
      sentAt: new Date().toISOString(),
      deliveryNote,
    })
    .where(eq(messagesTable.id, params.data.id))
    .returning();

  res.json(SendMessageResponse.parse(updated));
});

router.post("/messages/:id/cancel", async (req, res): Promise<void> => {
  const params = CancelMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  if (existing.status !== "draft" && existing.status !== "approved") {
    res
      .status(409)
      .json({ error: "Only draft or approved messages can be canceled." });
    return;
  }

  const [updated] = await db
    .update(messagesTable)
    .set({ status: "canceled" })
    .where(eq(messagesTable.id, params.data.id))
    .returning();

  res.json(CancelMessageResponse.parse(updated));
});

router.post("/messages/:id/acknowledge", async (req, res): Promise<void> => {
  const params = AcknowledgeMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  if (existing.source !== "system" || existing.status !== "failed") {
    res.status(409).json({
      error: "Only failed system alert messages can be acknowledged.",
    });
    return;
  }

  // Idempotent: if already acknowledged, return as-is without re-stamping.
  if (existing.readAt) {
    res.json(AcknowledgeMessageResponse.parse(existing));
    return;
  }

  const [updated] = await db
    .update(messagesTable)
    .set({ readAt: new Date().toISOString() })
    .where(eq(messagesTable.id, params.data.id))
    .returning();

  res.json(AcknowledgeMessageResponse.parse(updated));
});

router.delete("/messages/:id", async (req, res): Promise<void> => {
  const params = DeleteMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(messagesTable)
    .where(eq(messagesTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
