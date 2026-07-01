/**
 * Form Template Renderer
 * Converts template configuration + data into rendered HTML/PDF documents
 */

export interface BrandingConfig {
  logoUrl?: string;
  logoPosition: "top-left" | "top-center" | "top-right";
  backgroundColor: string;
  accentColor: string;
  companyName: string;
  companyAddress?: string;
  companyPhone?: string;
  companyEmail?: string;
  companyWebsite?: string;
  taxId?: string;
}

export interface LayoutConfig {
  headerTemplate: "default" | "minimal" | "detailed";
  showLineItemImages: boolean;
  showTaxBreakdown: boolean;
  showPaymentTerms: boolean;
  showNotesSection: boolean;
  pageOrientation: "portrait" | "landscape";
  pageSize: "letter" | "a4";
  margins: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

export interface FormTemplate {
  id: number;
  formType: "estimate" | "invoice" | "workOrder" | "purchaseOrder";
  templateName: string;
  isDefault: boolean;
  branding: BrandingConfig;
  layout: LayoutConfig;
  customFields?: Array<{
    fieldId: string;
    label: string;
    value?: string;
    visible: boolean;
    printable: boolean;
  }>;
  terms?: string;
  sections: {
    header?: { visible: boolean; height?: string };
    itemsTable?: { visible: boolean; columns?: string[] };
    totals?: { visible: boolean; showTax?: boolean; showDiscount?: boolean };
    footer?: { visible: boolean; content?: string };
  };
}

export interface EstimateData {
  id: number;
  estimateNumber: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  customerAddress?: string;
  vehicleInfo: string;
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
    category?: string;
  }>;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  notes?: string;
  createdDate: string;
  expiryDate?: string;
  status: string;
}

export interface InvoiceData {
  id: number;
  invoiceNumber: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  customerAddress?: string;
  vehicleInfo: string;
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
    category?: string;
  }>;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  balanceDue: number;
  dueDate?: string;
  notes?: string;
  invoiceDate: string;
  paymentMethods?: Array<{ type: string; details: string }>;
  status: string;
}

/**
 * Generate HTML for estimate
 */
export function renderEstimateHTML(template: FormTemplate, estimate: EstimateData): string {
  const margin = template.layout.margins;
  const padding = (n: number) => `${n * 16}px`; // Convert inches to pixels

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Estimate ${estimate.estimateNumber}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            color: #333;
            background: ${template.layout.pageOrientation === "landscape" ? "#f5f5f5" : "white"};
        }
        
        .document {
            background: white;
            margin: 0;
            padding: ${padding(margin.top)} ${padding(margin.right)} ${padding(margin.bottom)} ${padding(margin.left)};
            max-width: ${template.layout.pageSize === "a4" ? "210mm" : "8.5in"};
            ${template.layout.pageSize === "a4" ? "height: 297mm;" : "height: 11in;"}
            margin: 0 auto;
            box-shadow: 0 0 10px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 30px;
            border-bottom: 2px solid ${template.branding.accentColor};
            padding-bottom: 15px;
        }
        
        .company-info {
            flex: 1;
        }
        
        .logo {
            max-width: 150px;
            max-height: 60px;
            margin-bottom: 10px;
        }
        
        .company-name {
            font-size: 24px;
            font-weight: bold;
            color: ${template.branding.accentColor};
            margin-bottom: 5px;
        }
        
        .company-details {
            font-size: 12px;
            color: #666;
            line-height: 1.5;
        }
        
        .document-title {
            text-align: right;
            flex: 0 0 auto;
        }
        
        .title {
            font-size: 28px;
            font-weight: bold;
            color: ${template.branding.accentColor};
            margin-bottom: 10px;
        }
        
        .estimate-number {
            font-size: 14px;
            color: #666;
        }
        
        .info-section {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 20px;
            padding: 15px;
            background: #f9f9f9;
            border-radius: 5px;
        }
        
        .info-block h3 {
            font-size: 12px;
            font-weight: bold;
            color: ${template.branding.accentColor};
            text-transform: uppercase;
            margin-bottom: 8px;
            border-bottom: 1px solid #ddd;
            padding-bottom: 5px;
        }
        
        .info-block p {
            font-size: 12px;
            color: #555;
            line-height: 1.6;
            margin: 3px 0;
        }
        
        .items-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
        }
        
        .items-table thead {
            background: ${template.branding.accentColor};
            color: white;
        }
        
        .items-table th {
            padding: 10px;
            text-align: left;
            font-size: 12px;
            font-weight: 600;
            border: 1px solid ${template.branding.accentColor};
        }
        
        .items-table td {
            padding: 8px 10px;
            font-size: 11px;
            border: 1px solid #ddd;
        }
        
        .items-table tbody tr:nth-child(even) {
            background: #fafafa;
        }
        
        .items-table .quantity,
        .items-table .unitPrice,
        .items-table .total {
            text-align: right;
        }
        
        .totals-section {
            display: flex;
            justify-content: flex-end;
            margin-bottom: 20px;
        }
        
        .totals-box {
            width: 300px;
            border: 1px solid ${template.branding.accentColor};
            border-radius: 5px;
            overflow: hidden;
        }
        
        .total-line {
            display: flex;
            justify-content: space-between;
            padding: 8px 12px;
            font-size: 12px;
            border-bottom: 1px solid #eee;
        }
        
        .total-line:last-child {
            border-bottom: none;
        }
        
        .total-label {
            font-weight: 500;
            color: #555;
        }
        
        .total-value {
            font-weight: 600;
            text-align: right;
            min-width: 100px;
        }
        
        .total-final {
            background: ${template.branding.accentColor};
            color: white;
            font-size: 14px;
            font-weight: bold;
        }
        
        .total-final .total-label,
        .total-final .total-value {
            color: white;
        }
        
        .notes-section {
            background: #fffef5;
            border-left: 4px solid ${template.branding.accentColor};
            padding: 12px;
            margin-bottom: 15px;
            font-size: 11px;
            color: #555;
        }
        
        .terms-section {
            background: #f0f0f0;
            padding: 12px;
            margin-bottom: 15px;
            font-size: 10px;
            color: #666;
            border-radius: 3px;
        }
        
        .footer {
            border-top: 1px solid #ddd;
            padding-top: 10px;
            font-size: 10px;
            color: #999;
            text-align: center;
            margin-top: 20px;
        }
        
        @media print {
            body {
                background: white;
            }
            .document {
                box-shadow: none;
                max-width: 100%;
                height: auto;
            }
        }
    </style>
</head>
<body>
    <div class="document">
        <!-- Header -->
        <div class="header">
            <div class="company-info">
                ${template.branding.logoUrl ? `<img src="${template.branding.logoUrl}" class="logo" alt="Logo">` : ""}
                <div class="company-name">${template.branding.companyName}</div>
                <div class="company-details">
                    ${template.branding.companyAddress ? `<div>${template.branding.companyAddress}</div>` : ""}
                    ${template.branding.companyPhone ? `<div>${template.branding.companyPhone}</div>` : ""}
                    ${template.branding.companyEmail ? `<div>${template.branding.companyEmail}</div>` : ""}
                </div>
            </div>
            <div class="document-title">
                <div class="title">ESTIMATE</div>
                <div class="estimate-number">#${estimate.estimateNumber}</div>
            </div>
        </div>
        
        <!-- Customer & Vehicle Info -->
        <div class="info-section">
            <div class="info-block">
                <h3>Bill To</h3>
                <p><strong>${estimate.customerName}</strong></p>
                ${estimate.customerAddress ? `<p>${estimate.customerAddress}</p>` : ""}
                ${estimate.customerPhone ? `<p>${estimate.customerPhone}</p>` : ""}
                ${estimate.customerEmail ? `<p>${estimate.customerEmail}</p>` : ""}
            </div>
            <div class="info-block">
                <h3>Vehicle</h3>
                <p>${estimate.vehicleInfo}</p>
                ${template.customFields
                  ?.filter((f) => f.visible && f.printable)
                  .map(
                    (f) =>
                      `<p><strong>${f.label}:</strong> ${f.value || "—"}</p>`
                  )
                  .join("") || ""}
            </div>
        </div>
        
        <!-- Items Table -->
        <table class="items-table">
            <thead>
                <tr>
                    <th>Description</th>
                    <th class="quantity">Qty</th>
                    <th class="unitPrice">Unit Price</th>
                    <th class="total">Total</th>
                </tr>
            </thead>
            <tbody>
                ${estimate.items
                  .map(
                    (item) =>
                      `<tr>
                    <td>${item.description}</td>
                    <td class="quantity">${item.quantity}</td>
                    <td class="unitPrice">$${item.unitPrice.toFixed(2)}</td>
                    <td class="total">$${item.total.toFixed(2)}</td>
                </tr>`
                  )
                  .join("")}
            </tbody>
        </table>
        
        <!-- Totals -->
        <div class="totals-section">
            <div class="totals-box">
                <div class="total-line">
                    <span class="total-label">Subtotal</span>
                    <span class="total-value">$${estimate.subtotal.toFixed(2)}</span>
                </div>
                ${template.layout.showTaxBreakdown ? `
                <div class="total-line">
                    <span class="total-label">Tax (${(estimate.taxRate * 100).toFixed(1)}%)</span>
                    <span class="total-value">$${estimate.taxAmount.toFixed(2)}</span>
                </div>
                ` : ""}
                <div class="total-line total-final">
                    <span class="total-label">Total</span>
                    <span class="total-value">$${estimate.total.toFixed(2)}</span>
                </div>
            </div>
        </div>
        
        <!-- Notes -->
        ${template.layout.showNotesSection && estimate.notes ? `
        <div class="notes-section">
            <strong>Notes:</strong><br>
            ${estimate.notes}
        </div>
        ` : ""}
        
        <!-- Terms -->
        ${template.layout.showPaymentTerms && template.terms ? `
        <div class="terms-section">
            <strong>Terms:</strong><br>
            ${template.terms}
        </div>
        ` : ""}
        
        <!-- Footer -->
        <div class="footer">
            <p>Thank you for your business!</p>
            <p>Generated on ${new Date().toLocaleDateString()}</p>
        </div>
    </div>
</body>
</html>
  `;
}

/**
 * Generate HTML for invoice
 */
export function renderInvoiceHTML(template: FormTemplate, invoice: InvoiceData): string {
  // Similar to renderEstimateHTML but with invoice-specific fields
  // (balanceDue, paymentMethods, dueDate, etc.)
  return renderEstimateHTML(template, invoice as any); // Simplified
}

export default {
  renderEstimateHTML,
  renderInvoiceHTML,
};
