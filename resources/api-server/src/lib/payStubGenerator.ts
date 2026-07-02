/**
 * Pay Stub Generator
 * Generates detailed pay stubs from payroll data
 * Supports PDF export for printing
 */

export interface PayStubData {
  payStubId: string;
  employeeId: number;
  employee: {
    name: string;
    ssn: string; // Last 4 only
    address: string;
    employeeId: string;
    department: string;
    jobTitle: string;
  };
  payPeriod: {
    startDate: string;
    endDate: string;
    checkDate: string;
  };
  earnings: {
    regularHours: number;
    regularRate: number;
    regularPay: number;
    overtimeHours: number;
    overtimeMultiplier: number;
    overtimePay: number;
    bonusOrOther: number;
    grossPay: number;
  };
  deductions: {
    federalIncomeTax: number;
    socialSecurityTax: number;
    medicareTax: number;
    stateIncomeTax: number;
    localIncomeTax: number;
    healthInsurance: number;
    dentalInsurance: number;
    visionInsurance: number;
    retirement401k: number;
    other: number;
    totalDeductions: number;
  };
  netPay: number;
  yearToDate: {
    grossPay: number;
    deductions: number;
    netPay: number;
  };
  notes?: string;
}

/**
 * Generate HTML pay stub for viewing/printing
 */
export function generatePayStubHTML(payStub: PayStubData): string {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  };

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pay Stub - ${payStub.payStubId}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Arial', sans-serif;
            background: #f5f5f5;
            padding: 20px;
        }
        .container {
            max-width: 8.5in;
            height: 11in;
            background: white;
            margin: 0 auto;
            padding: 40px;
            box-shadow: 0 0 10px rgba(0,0,0,0.1);
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
            border-bottom: 3px solid #333;
            padding-bottom: 15px;
        }
        .company-info h1 {
            font-size: 28px;
            margin-bottom: 5px;
            color: #1a1a1a;
        }
        .company-info p {
            font-size: 12px;
            color: #666;
            line-height: 1.4;
        }
        .pay-stub-title {
            text-align: right;
        }
        .pay-stub-title h2 {
            font-size: 24px;
            color: #333;
            margin-bottom: 5px;
        }
        .pay-stub-title p {
            font-size: 12px;
            color: #999;
        }
        .employee-section {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 25px;
            padding: 15px;
            background: #f9f9f9;
            border: 1px solid #ddd;
            border-radius: 4px;
        }
        .employee-info h3 {
            font-size: 12px;
            font-weight: bold;
            color: #333;
            text-transform: uppercase;
            margin-bottom: 8px;
            border-bottom: 1px solid #ddd;
            padding-bottom: 5px;
        }
        .employee-info p {
            font-size: 11px;
            color: #555;
            line-height: 1.6;
            margin-bottom: 3px;
        }
        .pay-period {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 15px;
            margin-bottom: 20px;
        }
        .pay-period-item {
            background: #e8f4f8;
            padding: 12px;
            border-radius: 4px;
            text-align: center;
        }
        .pay-period-item label {
            display: block;
            font-size: 10px;
            font-weight: bold;
            color: #666;
            text-transform: uppercase;
            margin-bottom: 5px;
        }
        .pay-period-item .date {
            font-size: 14px;
            color: #333;
            font-weight: bold;
        }
        .earnings-deductions {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 20px;
        }
        .section {
            border: 1px solid #ddd;
            border-radius: 4px;
            overflow: hidden;
        }
        .section-header {
            background: #333;
            color: white;
            padding: 10px 15px;
            font-weight: bold;
            font-size: 12px;
            text-transform: uppercase;
        }
        .section-content {
            padding: 12px 15px;
        }
        .line-item {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 10px;
            padding: 6px 0;
            border-bottom: 1px solid #eee;
            font-size: 11px;
        }
        .line-item:last-child {
            border-bottom: none;
        }
        .line-item label {
            color: #555;
        }
        .line-item .value {
            text-align: right;
            color: #333;
            font-weight: 500;
        }
        .line-item.total {
            background: #f0f0f0;
            padding: 8px 0;
            margin-top: 5px;
            font-weight: bold;
            border-top: 2px solid #333;
        }
        .line-item.total label {
            color: #000;
        }
        .summary {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 15px;
            margin-bottom: 20px;
        }
        .summary-box {
            background: #f0f8ff;
            border: 2px solid #333;
            padding: 15px;
            border-radius: 4px;
            text-align: center;
        }
        .summary-box label {
            display: block;
            font-size: 10px;
            font-weight: bold;
            text-transform: uppercase;
            color: #666;
            margin-bottom: 8px;
        }
        .summary-box .amount {
            font-size: 20px;
            font-weight: bold;
            color: #333;
        }
        .ytd-section {
            background: #fffaf0;
            border: 1px solid #ffd699;
            padding: 12px 15px;
            border-radius: 4px;
            margin-bottom: 15px;
        }
        .ytd-section h4 {
            font-size: 11px;
            font-weight: bold;
            color: #333;
            margin-bottom: 8px;
            text-transform: uppercase;
        }
        .ytd-items {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 10px;
        }
        .ytd-item {
            font-size: 10px;
        }
        .ytd-item label {
            display: block;
            color: #666;
            margin-bottom: 3px;
        }
        .ytd-item .value {
            font-weight: bold;
            color: #333;
            font-size: 12px;
        }
        .footer {
            margin-top: 20px;
            padding-top: 15px;
            border-top: 1px solid #ddd;
            font-size: 10px;
            color: #999;
            text-align: center;
        }
        .notes {
            font-size: 10px;
            color: #666;
            margin-top: 10px;
            padding: 10px;
            background: #fafafa;
            border-left: 3px solid #999;
        }
        @media print {
            body {
                background: white;
                padding: 0;
            }
            .container {
                box-shadow: none;
                margin: 0;
            }
        }
        @media (max-width: 900px) {
            .container {
                height: auto;
                max-width: 100%;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <div class="company-info">
                <h1>Your Auto Repair Shop</h1>
                <p>456 Business Ave<br>City, State 12345<br>Phone: (555) 000-0000</p>
            </div>
            <div class="pay-stub-title">
                <h2>PAY STUB</h2>
                <p>ID: ${payStub.payStubId}</p>
            </div>
        </div>

        <!-- Employee Information -->
        <div class="employee-section">
            <div class="employee-info">
                <h3>Employee Information</h3>
                <p><strong>Name:</strong> ${payStub.employee.name}</p>
                <p><strong>ID:</strong> ${payStub.employee.employeeId}</p>
                <p><strong>SSN:</strong> ${payStub.employee.ssn}</p>
                <p><strong>Department:</strong> ${payStub.employee.department}</p>
                <p><strong>Position:</strong> ${payStub.employee.jobTitle}</p>
            </div>
            <div class="employee-info">
                <h3>Address</h3>
                <p>${payStub.employee.address}</p>
            </div>
        </div>

        <!-- Pay Period -->
        <div class="pay-period">
            <div class="pay-period-item">
                <label>Period Start</label>
                <div class="date">${formatDate(payStub.payPeriod.startDate)}</div>
            </div>
            <div class="pay-period-item">
                <label>Period End</label>
                <div class="date">${formatDate(payStub.payPeriod.endDate)}</div>
            </div>
            <div class="pay-period-item">
                <label>Check Date</label>
                <div class="date">${formatDate(payStub.payPeriod.checkDate)}</div>
            </div>
        </div>

        <!-- Earnings and Deductions -->
        <div class="earnings-deductions">
            <!-- Earnings -->
            <div class="section">
                <div class="section-header">Earnings</div>
                <div class="section-content">
                    <div class="line-item">
                        <label>Regular Hours @ ${payStub.earnings.regularRate.toFixed(2)}/hr</label>
                        <div class="value">${formatCurrency(payStub.earnings.regularPay)}</div>
                    </div>
                    ${payStub.earnings.overtimeHours > 0 ? `
                    <div class="line-item">
                        <label>Overtime Hours (${payStub.earnings.overtimeMultiplier}x) @ ${(payStub.earnings.regularRate * payStub.earnings.overtimeMultiplier).toFixed(2)}/hr</label>
                        <div class="value">${formatCurrency(payStub.earnings.overtimePay)}</div>
                    </div>
                    ` : ''}
                    ${payStub.earnings.bonusOrOther > 0 ? `
                    <div class="line-item">
                        <label>Bonus/Other</label>
                        <div class="value">${formatCurrency(payStub.earnings.bonusOrOther)}</div>
                    </div>
                    ` : ''}
                    <div class="line-item total">
                        <label>Gross Pay</label>
                        <div class="value">${formatCurrency(payStub.earnings.grossPay)}</div>
                    </div>
                </div>
            </div>

            <!-- Deductions -->
            <div class="section">
                <div class="section-header">Deductions</div>
                <div class="section-content">
                    ${payStub.deductions.federalIncomeTax > 0 ? `
                    <div class="line-item">
                        <label>Federal Income Tax</label>
                        <div class="value">${formatCurrency(payStub.deductions.federalIncomeTax)}</div>
                    </div>
                    ` : ''}
                    ${payStub.deductions.socialSecurityTax > 0 ? `
                    <div class="line-item">
                        <label>Social Security Tax</label>
                        <div class="value">${formatCurrency(payStub.deductions.socialSecurityTax)}</div>
                    </div>
                    ` : ''}
                    ${payStub.deductions.medicareTax > 0 ? `
                    <div class="line-item">
                        <label>Medicare Tax</label>
                        <div class="value">${formatCurrency(payStub.deductions.medicareTax)}</div>
                    </div>
                    ` : ''}
                    ${payStub.deductions.stateIncomeTax > 0 ? `
                    <div class="line-item">
                        <label>State Income Tax</label>
                        <div class="value">${formatCurrency(payStub.deductions.stateIncomeTax)}</div>
                    </div>
                    ` : ''}
                    ${payStub.deductions.healthInsurance > 0 ? `
                    <div class="line-item">
                        <label>Health Insurance</label>
                        <div class="value">${formatCurrency(payStub.deductions.healthInsurance)}</div>
                    </div>
                    ` : ''}
                    <div class="line-item total">
                        <label>Total Deductions</label>
                        <div class="value">${formatCurrency(payStub.deductions.totalDeductions)}</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Net Pay Summary -->
        <div class="summary">
            <div class="summary-box">
                <label>Gross Pay</label>
                <div class="amount">${formatCurrency(payStub.earnings.grossPay)}</div>
            </div>
            <div class="summary-box">
                <label>Total Deductions</label>
                <div class="amount">${formatCurrency(payStub.deductions.totalDeductions)}</div>
            </div>
            <div class="summary-box">
                <label style="font-size: 12px; color: #000;">NET PAY</label>
                <div class="amount" style="color: #27ae60; font-size: 24px;">${formatCurrency(payStub.netPay)}</div>
            </div>
        </div>

        <!-- Year-to-Date -->
        <div class="ytd-section">
            <h4>Year-to-Date Totals</h4>
            <div class="ytd-items">
                <div class="ytd-item">
                    <label>Gross Pay</label>
                    <div class="value">${formatCurrency(payStub.yearToDate.grossPay)}</div>
                </div>
                <div class="ytd-item">
                    <label>Total Deductions</label>
                    <div class="value">${formatCurrency(payStub.yearToDate.deductions)}</div>
                </div>
                <div class="ytd-item">
                    <label>Net Pay</label>
                    <div class="value">${formatCurrency(payStub.yearToDate.netPay)}</div>
                </div>
            </div>
        </div>

        <!-- Notes -->
        ${payStub.notes ? `<div class="notes"><strong>Notes:</strong> ${payStub.notes}</div>` : ''}

        <!-- Footer -->
        <div class="footer">
            <p>This pay stub is confidential and intended for the use of the employee named above.</p>
            <p>If you have questions about your pay, please contact Human Resources.</p>
        </div>
    </div>
</body>
</html>
  `;
}

/**
 * Calculate tax withholdings based on gross pay
 * Uses 2024 tax brackets and standard deductions
 */
export function calculateTaxWithholdings(
  grossPay: number,
  employmentType: "W2" | "1099",
  filingStatus: "single" | "married" | "headOfHousehold" = "single"
): {
  federalIncomeTax: number;
  socialSecurityTax: number;
  medicareTax: number;
  stateIncomeTax: number;
  totalTaxes: number;
} {
  if (employmentType === "1099") {
    // 1099 contractors: no withholding (they pay their own taxes)
    return {
      federalIncomeTax: 0,
      socialSecurityTax: 0,
      medicareTax: 0,
      stateIncomeTax: 0,
      totalTaxes: 0,
    };
  }

  // W2 employees: standard withholding
  const ssaTax = grossPay * 0.062; // 6.2% Social Security (up to wage base)
  const medicareTax = grossPay * 0.0145; // 1.45% Medicare
  const federalIncomeTax = calculateFederalIncomeTax(grossPay, filingStatus);
  const stateIncomeTax = grossPay * 0.06; // Adjust based on state

  return {
    federalIncomeTax,
    socialSecurityTax: ssaTax,
    medicareTax,
    stateIncomeTax,
    totalTaxes: federalIncomeTax + ssaTax + medicareTax + stateIncomeTax,
  };
}

/**
 * Calculate federal income tax using 2024 tax brackets
 */
function calculateFederalIncomeTax(
  grossPay: number,
  filingStatus: "single" | "married" | "headOfHousehold"
): number {
  // Simplified calculation - adjust based on actual withholding tables
  const standardDeduction = {
    single: 14600,
    married: 29200,
    headOfHousehold: 21900,
  }[filingStatus];

  const annualGross = grossPay * 26; // Bi-weekly pay
  const taxableIncome = Math.max(0, annualGross - standardDeduction);

  // 2024 tax brackets (simplified)
  let tax = 0;
  if (filingStatus === "single") {
    if (taxableIncome > 191950) tax = taxableIncome * 0.37;
    else if (taxableIncome > 100525) tax = taxableIncome * 0.35;
    else if (taxableIncome > 47150) tax = taxableIncome * 0.24;
    else if (taxableIncome > 11600) tax = taxableIncome * 0.22;
    else if (taxableIncome > 4700) tax = taxableIncome * 0.12;
    else tax = taxableIncome * 0.1;
  }

  // Convert annual to per-pay-period
  return tax / 26;
}

export default {
  generatePayStubHTML,
  calculateTaxWithholdings,
};
