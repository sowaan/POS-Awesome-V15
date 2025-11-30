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
        size: 100,
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
	const totalQty = invoice.items?.reduce((sum, item) => sum + (item.qty || 0), 0);

    return`
	<!DOCTYPE html>
	<html>
	<head>
	<meta charset="UTF-8">
	<title>Receipt</title>
	
	<style>
	
	.print-format {
		width: 58mm;             
		margin: 0;
		padding: 0 3px;
		font-family: Monospace !important;
		font-size: 9px;
	}
	
	table {
		width: 100%;
		border-collapse: collapse;
	}
	
	.no-border,
	.no-border td,
	.no-border th {
		border: none !important;
	}
	
	td, th {
		padding: 0 !important;
		margin: 0 !important;
		line-height: 1.1;
	}
	
	.text-right { text-align: right; }
	.text-left  { text-align: left; }
	.text-center { text-align: center; }
	
	hr {
		border-top: 1px dashed black;
		margin: 2px 0;
	}
	
	.logo {
		width: 90px;
	}
	
	.qr-img {
		width: 70px;
	}
	
	</style>
	</head>
	
	<body>
	<div class="print-format">
	
		<!-- LOGO -->
		<div style="text-align: left;">
			<img src="/assets/posawesome/images/comp.jpg" width="80">
		</div>
	
		<hr>
	
		<!-- HEADER INFO -->
		<p>
			FBR Number: ${fbrNumber}<br>
			Customer: ${invoice.customer || "Walk-in"}<br>
			Date: ${invoice.posting_date}
		</p>
	
		<hr>
	
		<!-- ITEM TABLE -->
		<table>
			<thead>
				<tr>
					<th width="38%">Item</th>
					<th width="12%">Price</th>
					<th width="10%">Dis</th>
					<th width="10%" class="text-right">Qty</th>
					<th width="10%" class="text-right">Rate</th>
					<th width="20%" class="text-right">Amount</th>
				</tr>
			</thead>
	
			<tbody>
				${invoice.items
					.map(item => `
					<tr>
						<td colspan="6"><b>${item.item_name}</b></td>
					</tr>
	
					<tr>
						<td></td>
						<td>${item.price_list_rate}</td>
						<td>${item.discount_amount || 0}</td>
						<td class="text-right">${item.qty}</td>
						<td class="text-right">${item.rate}</td>
						<td class="text-right">${item.amount}</td>
					</tr>
				`).join('')}
			</tbody>
		</table>
	
		<hr>
	
		<!-- TOTALS SECTION -->
		<table class="no-border">
	
			<tr>
				<td>Net Total</td>
				<td class="text-right">${invoice.total}</td>
			</tr>
	
			<tr>
				<td>GST @${invoice.taxes?.[0]?.rate || 0}%</td>
				<td class="text-right">${invoice.total_taxes_and_charges}</td>
			</tr>
	
			${invoice.discount_amount ? `
			<tr>
				<td>Discount</td>
				<td class="text-right">-${invoice.discount_amount}</td>
			</tr>` : ''}
	
			<tr>
				<td><b>Grand Total</b></td>
				<td class="text-right"><b>${invoice.grand_total}</b></td>
			</tr>
	
			<tr>
				<td>Paid Amount</td>
				<td class="text-right">${invoice.paid_amount}</td>
			</tr>
	
			<tr>
				<td>Total Qty</td>
				<td class="text-right">${totalQty}</td>
			</tr>
	
		</table>
	
		<hr>
	
		<p class="text-center">Thank you, please visit again.</p>
	
		<!-- FBR Logo -->
		<div style="text-align:center; margin-top:5px;">
			<img src="/assets/posawesome/images/fbr_loog.png" width="80">
		</div>

		<!-- QR CODE -->
		${qrSVG ? `
		<div style="text-align:center; margin-top:5px;">
			${qrSVG.replace('<svg', '<svg width="70" height="70"')}
		</div>` : ""}

	
		${fbrNumber ? `<p class="text-center"><b>${fbrNumber}</b></p>` : ""}
	
		<p style="text-align:center; margin-top:10px;">Powered by Sowaan ERP</p>	
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