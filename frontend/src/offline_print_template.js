/* global frappe */
import { getPrintTemplate, getTermsAndConditions, memoryInitPromise } from "./offline/index.js";
import nunjucks from "nunjucks";

function normaliseTemplate(template) {
	// Nunjucks doesn't understand Python-style triple quotes.
	// Convert any """multiline""" strings to standard JS strings so the
	// renderer can parse templates that include SQL or other blocks.
	if (!template) return template;
	return template.replace(/"""([\s\S]*?)"""/g, (_, str) => {
		const escaped = str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
		return `"${escaped}"`;
	});
}

function attachFormatter(obj) {
	if (!obj || typeof obj !== "object" || obj.get_formatted) return;
	// mimic Frappe's get_formatted by returning the raw field value
	obj.get_formatted = function (field) {
		return this?.[field];
	};
}

function computePaidAmount(doc) {
	if (!doc) return 0;

	const paymentsTotal = (doc.payments || []).reduce(
		(sum, p) => sum + Math.abs(parseFloat(p.amount) || 0),
		0,
	);

	const creditSale =
		doc.is_credit_sale === true ||
		doc.is_credit_sale === 1 ||
		doc.is_credit_sale === "1" ||
		String(doc.is_credit_sale).toLowerCase() === "yes";

	if (creditSale || paymentsTotal === 0) {
		return 0;
	}

	const base = doc.paid_amount ?? doc.grand_total ?? 0;
	return paymentsTotal || base;
}

import kjua from 'kjua';

function generateQRCodeSVG(data) {
    return kjua({
        render: 'svg',
        text: data,
        size: 150,
        fill: '#000',
        back: '#fff',
        rounded: 0,
        quiet: 0
    }).outerHTML;
}

export function defaultOfflineHTML(invoice, terms = "") {
    if (!invoice) return "";

    const fbrNumber =
        invoice.custom_fbr_fiscal_invoice_number ||
        invoice.custom_fbr_invoice_no ||
        invoice.fiscal_invoice_number ||
        invoice.InvoiceNumber ||
        "";

    const qrSVG = fbrNumber ? generateQRCodeSVG(fbrNumber) : "";

    const itemsRows = (invoice.items || [])
    .map((it, i) => {
        const marker = invoice.posa_show_custom_name_marker_on_print && it.name_overridden ? " (custom)" : "";
        const sn = it.serial_no ? `<div class="serial">SR.No: ${it.serial_no.replace(/\n/g, ", ")}</div>` : "";
	
        return `
            <!-- Heading Row (ONCE) -->
            ${i === 0 ? `
            <tr class="heading-row">
                <th width="20%" style="padding:0px !important; border:none;">Item</th>
				<th width="10%" style="padding:0px !important; border:none;" class="text-right">Price</th>
                <th width="10%" style="padding:0px !important; border:none;" class="text-right">Dis</th>
				<th width="10%" style="padding:0px !important; border:none;" class="text-right">Qty</th>
                <th width="10%" style="padding:0px !important; border:none;" class="text-right">Rate</th>
                <th width="10%" style="padding:0px !important; border:none;" class="text-right">Amount</th>
            </tr>
            ` : ""}

            <!-- Item name full row -->
            <tr>
                <td colspan="4" style="padding:0px !important; border:none; font-weight:bold;">
                    ${it.item_name || it.item_code}${marker}${sn}
                </td>
            </tr>

            <!-- Row with Qty, Rate, Amount -->
            <tr>
                <td style="padding:0px !important; border:none;"></td>
				<td width="10%" class="text-right" style="padding:0px !important; border:none;">${it.price_list_rate}</td>
				<td width="10%" class="text-right" style="padding:0px !important; border:none;">${it.discount_amount}</td>
                <td width="10%" class="text-right" style="padding:0px !important; border:none;">${it.qty}</td>
                <td width="10%" class="text-right" style="padding:0px !important; border:none;">${it.rate}</td>
                <td width="10%" class="text-right" style="padding:0px !important; border:none;">${it.amount}</td>
            </tr>
        `;
    })
    .join("");
	const taxRate = invoice.taxes?.length ? invoice.taxes[0].rate : 0;

    return `<!DOCTYPE html>
		<html>
		<head>
		<meta charset="UTF-8">
		<title>Invoice</title>
		<style>
		body { font-family: Arial, sans-serif; font-size: 12px; }
		.details div { margin-bottom: 4px; }
		table { width: 100%; border-collapse: collapse; margin-top: 10px; }
		th, td { 
			padding: 6px; 
			text-align: left; 
			border: none !important;      /* Removes all borders */
		}
		.item-row { font-weight: bold; padding-top: 10px; }
		.sub-row td { padding-left: 15px; font-size: 11px; }
		.totals td { text-align: right; padding: 4px; border: none !important; }
		.footer { text-align: center; margin-top: 20px; font-size: 10px; }
		.qr-block { text-align: center; margin: 15px 0; }
		.qr-block svg { width: 150px; height: 150px; }
		</style>
		</head>
		<body>

		<div style="text-align:center; margin-bottom: 20px;">
			<h2>${invoice.company || 'Invoice'}</h2>
			${qrSVG ? `<div class="qr-block">${qrSVG}</div>` : ''}
			${fbrNumber ? `<div><strong>FBR No:</strong> ${fbrNumber}</div>` : ''}
		</div>

		<div class="details">
			<div><strong>Invoice #:</strong> ${invoice.name}</div>
			<div><strong>Customer:</strong> ${invoice.customer || 'Walk-in'}</div>
			<div><strong>Date:</strong> ${invoice.posting_date}</div>
		</div>

		<table>
		<tbody>
		${itemsRows}
		</tbody>
		</table>

		<table class="totals">
		<tr><td style="text-align:left">Net Total:</td><td>${invoice.total}</td></tr>
		<tr><td style="text-align:left">GST @${taxRate}:</td><td>${invoice.total_taxes_and_charges}</td></tr>
		<tr><td style="text-align:left">Discount:</td><td>${invoice.discount_amount || 0}</td></tr>
		<tr><td style="text-align:left"><strong>Grand Total:</strong></td><td><strong>${invoice.grand_total}</strong></td></tr>
		<tr><td style="text-align:left">Paid:</td><td>${invoice.paid_amount}</td></tr>
		<tr><td style="text-align:left">Qty Total:</td><td>${invoice.total_qty}</td></tr>
		</table>

		<div class="footer">
			Thank you for your purchase!<br>
			Powered by SowaanERP
		</div>

		<div style="text-align:center; margin-top:15px;">
			<img src="/assets/posawesome/images/image.png" style="width:140px; height:auto;">
		</div>

		</body>
		</html>`;
}




export default async function renderOfflineInvoiceHTML(invoice) {
	if (!invoice) return "";

	await memoryInitPromise;

	const template = normaliseTemplate(getPrintTemplate());
	const terms = getTermsAndConditions();
	const doc = {
		...invoice,
		terms: invoice.terms || terms,
		terms_and_conditions: invoice.terms_and_conditions || terms,
	};

	doc.paid_amount = computePaidAmount(doc);
	attachFormatter(doc);
	(doc.items || []).forEach(attachFormatter);
	(doc.taxes || []).forEach(attachFormatter);

	if (!template) {
		console.warn("No offline print template cached; using fallback template");
		return defaultOfflineHTML(doc, doc.terms_and_conditions);
	}

	try {
		const env = nunjucks.configure({ autoescape: false });
		env.addFilter("format_currency", (value, currency) => {
			const number = typeof value === "number" ? value : parseFloat(value);
			if (Number.isNaN(number)) return value;
			try {
				return new Intl.NumberFormat(undefined, {
					style: currency ? "currency" : "decimal",
					currency: currency || undefined,
				}).format(number);
			} catch {
				return currency ? `${currency} ${number}` : String(number);
			}
		});
		env.addFilter("currency", (value, currency) => env.filters.format_currency(value, currency));
		env.getFilter = function (name) {
			return this.filters[name] || ((v) => v);
		};

		const context = {
			doc,
			terms: doc.terms,
			terms_and_conditions: doc.terms_and_conditions,
			_: frappe?._ ? frappe._ : (t) => t,
			frappe: {
				db: { get_value: () => "", sql: () => [] },
				get_list: () => [],
			},
		};
		return env.renderString(template, context);
	} catch (e) {
		console.error("Failed to render offline invoice", e);
		return defaultOfflineHTML(doc, doc.terms_and_conditions);
	}
}
