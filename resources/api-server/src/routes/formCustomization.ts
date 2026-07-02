import { Router, type IRouter, type Request } from "express";
import { logger } from "../lib/logger";
import { hasPermission } from "../lib/auth";
import { readJsonFile, writeJsonFile } from "../lib/jsonFileStore";

type FormType =
  | "estimate"
  | "invoice"
  | "workOrder"
  | "purchaseOrder"
  | "report";

interface FormTemplate {
  id: number;
  formType: FormType;
  templateName: string;
  isDefault: boolean;
  branding: {
    companyName: string;
    companyAddress: string;
    companyPhone: string;
    companyEmail: string;
    logoUrl: string | null;
    accentColor: string;
  };
  layout: {
    pageSize: "letter" | "a4";
    pageOrientation: "portrait" | "landscape";
    showNotesSection: boolean;
    showTaxBreakdown: boolean;
    showPaymentTerms: boolean;
    compactLineItems: boolean;
  };
  customFields: Array<{
    fieldId: string;
    label: string;
    value: string;
    visible: boolean;
    printable: boolean;
  }>;
  terms: string;
  notes: string;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
}

interface TemplateStore {
  templates: FormTemplate[];
}

const STORE_FILE = "form-templates.json";
const EMPTY_STORE: TemplateStore = { templates: [] };

const router: IRouter = Router();

function nowIso(): string {
  return new Date().toISOString();
}

function nextId(items: Array<{ id: number }>): number {
  let max = 0;
  for (const item of items) {
    if (item.id > max) max = item.id;
  }
  return max + 1;
}

async function loadStore(): Promise<TemplateStore> {
  return readJsonFile<TemplateStore>(STORE_FILE, EMPTY_STORE);
}

async function saveStore(store: TemplateStore): Promise<void> {
  await writeJsonFile(STORE_FILE, store);
}

function canManageTemplates(req: Request): boolean {
  if (!req.currentUser) return false;
  if (req.currentUser.role === "admin") return true;
  return hasPermission(req, "settings");
}

function requireTemplateAdmin(req: Request, res: Parameters<IRouter["get"]>[1], next: () => void): void {
  if (!req.currentUser) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (!canManageTemplates(req)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }
  next();
}

function normalizeType(value: unknown): FormType | null {
  if (value === "estimate" || value === "invoice" || value === "workOrder" || value === "purchaseOrder" || value === "report") {
    return value;
  }
  return null;
}

function normalizeTemplateBody(body: unknown): Omit<FormTemplate, "id" | "createdByUserId" | "createdAt" | "updatedAt"> | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const formType = normalizeType(b.formType);
  if (!formType) return null;
  const templateName = typeof b.templateName === "string" ? b.templateName.trim() : "";
  if (!templateName) return null;

  const brandingRaw = (b.branding ?? {}) as Record<string, unknown>;
  const layoutRaw = (b.layout ?? {}) as Record<string, unknown>;
  const fieldsRaw = Array.isArray(b.customFields) ? b.customFields : [];

  return {
    formType,
    templateName,
    isDefault: Boolean(b.isDefault),
    branding: {
      companyName: typeof brandingRaw.companyName === "string" ? brandingRaw.companyName : "",
      companyAddress: typeof brandingRaw.companyAddress === "string" ? brandingRaw.companyAddress : "",
      companyPhone: typeof brandingRaw.companyPhone === "string" ? brandingRaw.companyPhone : "",
      companyEmail: typeof brandingRaw.companyEmail === "string" ? brandingRaw.companyEmail : "",
      logoUrl: typeof brandingRaw.logoUrl === "string" && brandingRaw.logoUrl.trim() ? brandingRaw.logoUrl : null,
      accentColor: typeof brandingRaw.accentColor === "string" && brandingRaw.accentColor.trim() ? brandingRaw.accentColor : "#1C4E80",
    },
    layout: {
      pageSize: layoutRaw.pageSize === "a4" ? "a4" : "letter",
      pageOrientation: layoutRaw.pageOrientation === "landscape" ? "landscape" : "portrait",
      showNotesSection: layoutRaw.showNotesSection !== false,
      showTaxBreakdown: layoutRaw.showTaxBreakdown !== false,
      showPaymentTerms: layoutRaw.showPaymentTerms !== false,
      compactLineItems: layoutRaw.compactLineItems === true,
    },
    customFields: fieldsRaw
      .map((f) => {
        const item = f as Record<string, unknown>;
        const fieldId = typeof item.fieldId === "string" ? item.fieldId.trim() : "";
        const label = typeof item.label === "string" ? item.label.trim() : "";
        if (!fieldId || !label) return null;
        return {
          fieldId,
          label,
          value: typeof item.value === "string" ? item.value : "",
          visible: item.visible !== false,
          printable: item.printable !== false,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    terms: typeof b.terms === "string" ? b.terms : "",
    notes: typeof b.notes === "string" ? b.notes : "",
  };
}

function renderTemplateHtml(template: FormTemplate, title: string, sampleData: Record<string, unknown>): string {
  const accent = template.branding.accentColor || "#1C4E80";
  const fields = template.customFields
    .filter((f) => f.visible && f.printable)
    .map((f) => `<tr><td>${f.label}</td><td>${f.value || "-"}</td></tr>`)
    .join("\n");

  const dataRows = Object.entries(sampleData)
    .slice(0, 20)
    .map(([key, value]) => `<tr><td>${key}</td><td>${String(value ?? "")}</td></tr>`)
    .join("\n");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #1b1b1b; }
      .header { border-bottom: 3px solid ${accent}; padding-bottom: 12px; margin-bottom: 16px; }
      .title { color: ${accent}; font-size: 22px; margin: 0; }
      .meta { color: #555; margin-top: 6px; }
      table { width: 100%; border-collapse: collapse; margin-top: 12px; }
      td, th { border: 1px solid #ddd; padding: 8px; vertical-align: top; }
      th { background: #f7f7f7; text-align: left; }
      .notes { margin-top: 16px; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <section class="header">
      <h1 class="title">${title} - ${template.templateName}</h1>
      <div class="meta">${template.branding.companyName}</div>
      <div class="meta">${template.branding.companyAddress}</div>
      <div class="meta">${template.branding.companyPhone} ${template.branding.companyEmail}</div>
    </section>
    <section>
      <h2>Custom Fields</h2>
      <table>
        <tbody>
          ${fields || "<tr><td colspan=\"2\">No custom fields configured.</td></tr>"}
        </tbody>
      </table>
    </section>
    <section>
      <h2>Document Data</h2>
      <table>
        <tbody>
          ${dataRows || "<tr><td colspan=\"2\">No document data provided.</td></tr>"}
        </tbody>
      </table>
    </section>
    ${template.layout.showPaymentTerms ? `<section class="notes"><strong>Terms:</strong> ${template.terms || "-"}</section>` : ""}
    ${template.layout.showNotesSection ? `<section class="notes"><strong>Notes:</strong> ${template.notes || "-"}</section>` : ""}
  </body>
</html>`;
}

router.post("/forms/templates", requireTemplateAdmin, async (req, res) => {
  try {
    const normalized = normalizeTemplateBody(req.body);
    if (!normalized) {
      res.status(400).json({ error: "Invalid payload. formType and templateName are required." });
      return;
    }

    const store = await loadStore();
    const ts = nowIso();

    if (normalized.isDefault) {
      for (const tpl of store.templates) {
        if (tpl.formType === normalized.formType) tpl.isDefault = false;
      }
    }

    const template: FormTemplate = {
      id: nextId(store.templates),
      ...normalized,
      createdByUserId: req.currentUser!.id,
      createdAt: ts,
      updatedAt: ts,
    };

    store.templates.push(template);
    await saveStore(store);

    res.status(201).json({ success: true, message: "Form template created successfully", templateId: template.id, template });
  } catch (err) {
    logger.error({ err }, "Failed to create form template");
    res.status(500).json({ error: "Failed to create form template" });
  }
});

router.get("/forms/templates", requireTemplateAdmin, async (req, res) => {
  try {
    const formType = normalizeType(req.query.formType);
    const store = await loadStore();
    const templates = formType
      ? store.templates.filter((t) => t.formType === formType)
      : store.templates;
    res.json({ success: true, templates });
  } catch (err) {
    logger.error({ err }, "Failed to list form templates");
    res.status(500).json({ error: "Failed to list form templates" });
  }
});

router.get("/forms/templates/:templateId", requireTemplateAdmin, async (req, res) => {
  try {
    const templateId = Number(req.params.templateId);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      res.status(400).json({ error: "Invalid template id" });
      return;
    }
    const store = await loadStore();
    const template = store.templates.find((t) => t.id === templateId);
    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    res.json({ success: true, template });
  } catch (err) {
    logger.error({ err }, "Failed to get form template");
    res.status(500).json({ error: "Failed to get form template" });
  }
});

router.patch("/forms/templates/:templateId", requireTemplateAdmin, async (req, res) => {
  try {
    const templateId = Number(req.params.templateId);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      res.status(400).json({ error: "Invalid template id" });
      return;
    }

    const store = await loadStore();
    const current = store.templates.find((t) => t.id === templateId);
    if (!current) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    const normalized = normalizeTemplateBody({ ...current, ...req.body, formType: req.body?.formType ?? current.formType, templateName: req.body?.templateName ?? current.templateName });
    if (!normalized) {
      res.status(400).json({ error: "Invalid update payload" });
      return;
    }

    if (normalized.isDefault) {
      for (const tpl of store.templates) {
        if (tpl.formType === normalized.formType) tpl.isDefault = false;
      }
    }

    Object.assign(current, normalized, { updatedAt: nowIso() });
    await saveStore(store);

    res.json({ success: true, message: "Form template updated successfully", template: current });
  } catch (err) {
    logger.error({ err }, "Failed to update form template");
    res.status(500).json({ error: "Failed to update form template" });
  }
});

router.delete("/forms/templates/:templateId", requireTemplateAdmin, async (req, res) => {
  try {
    const templateId = Number(req.params.templateId);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      res.status(400).json({ error: "Invalid template id" });
      return;
    }
    const store = await loadStore();
    const before = store.templates.length;
    store.templates = store.templates.filter((t) => t.id !== templateId);
    if (store.templates.length === before) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    await saveStore(store);
    res.json({ success: true, message: "Form template deleted successfully" });
  } catch (err) {
    logger.error({ err }, "Failed to delete form template");
    res.status(500).json({ error: "Failed to delete form template" });
  }
});

router.post("/forms/preview", requireTemplateAdmin, async (req, res) => {
  try {
    const templateId = Number(req.body?.templateId);
    const formType = normalizeType(req.body?.formType);
    if (!Number.isInteger(templateId) || !formType) {
      res.status(400).json({ error: "templateId and formType are required" });
      return;
    }

    const store = await loadStore();
    const template = store.templates.find((t) => t.id === templateId && t.formType === formType);
    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    const sampleData =
      req.body && typeof req.body.sampleData === "object" && req.body.sampleData !== null
        ? (req.body.sampleData as Record<string, unknown>)
        : {};

    const preview = renderTemplateHtml(template, `Preview ${formType}`, sampleData);
    res.json({ success: true, preview });
  } catch (err) {
    logger.error({ err }, "Failed to generate preview");
    res.status(500).json({ error: "Failed to generate preview" });
  }
});

async function renderEntityTemplate(res: Parameters<IRouter["get"]>[1], formType: FormType, entityId: string, format: unknown): Promise<void> {
  const store = await loadStore();
  const template =
    store.templates.find((t) => t.formType === formType && t.isDefault) ??
    store.templates.find((t) => t.formType === formType);

  if (!template) {
    res.status(404).json({ error: `No template found for ${formType}` });
    return;
  }

  if (format === "pdf") {
    res.status(501).json({ error: "PDF rendering is not yet enabled for template output" });
    return;
  }

  const html = renderTemplateHtml(template, `${formType} ${entityId}`, {
    id: entityId,
    renderedAt: nowIso(),
    formType,
    source: "template-renderer",
  });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

router.get("/forms/estimate/:estimateId/render", async (req, res) => {
  try {
    await renderEntityTemplate(res, "estimate", req.params.estimateId, req.query.format);
  } catch (err) {
    logger.error({ err }, "Failed to render estimate");
    res.status(500).json({ error: "Failed to render estimate" });
  }
});

router.get("/forms/invoice/:invoiceId/render", async (req, res) => {
  try {
    await renderEntityTemplate(res, "invoice", req.params.invoiceId, req.query.format);
  } catch (err) {
    logger.error({ err }, "Failed to render invoice");
    res.status(500).json({ error: "Failed to render invoice" });
  }
});

router.get("/forms/work-order/:workOrderId/render", async (req, res) => {
  try {
    await renderEntityTemplate(res, "workOrder", req.params.workOrderId, req.query.format);
  } catch (err) {
    logger.error({ err }, "Failed to render work order");
    res.status(500).json({ error: "Failed to render work order" });
  }
});

router.get("/forms/purchase-order/:purchaseOrderId/render", async (req, res) => {
  try {
    await renderEntityTemplate(res, "purchaseOrder", req.params.purchaseOrderId, req.query.format);
  } catch (err) {
    logger.error({ err }, "Failed to render purchase order");
    res.status(500).json({ error: "Failed to render purchase order" });
  }
});

export default router;
