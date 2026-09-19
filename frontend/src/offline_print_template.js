/* global frappe */
import { getPrintTemplate, getTermsAndConditions, memoryInitPromise } from "./offline/index.js";
import nunjucks from "nunjucks";

function normaliseTemplate(template) {
	// Nunjucks doesn't understand Python-style triple quotes.
	// Convert any """multiline""" strings to standard JS strings so the
	// renderer can parse templates that include SQL or other blocks.
	if (!template) return template;
	return (
		template
			.replace(/"""([\s\S]*?)"""/g, (_, str) => {
				const escaped = str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
				return `"${escaped}"`;
			})
			// Jinja dictionaries expose update(); JavaScript object literals do not.
			// Route this common print-format pattern through a compatible helper.
			.replace(
				/{%\s*if\s+([A-Za-z_]\w*)\.update\((\{[\s\S]*?\})\)\s*%}/g,
				"{% if dict_update($1, $2) %}",
			)
			// Nunjucks cannot assign an object property with `set ns.value = ...`,
			// which is the standard Jinja namespace pattern used by print formats.
			.replace(
				/{%\s*set\s+([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*([\s\S]*?)\s*%}/g,
				'{% set $1 = dict_set($1, "$2", $3) %}',
			)
	);
}

function attachFormatter(obj) {
	if (!obj || typeof obj !== "object" || obj.get_formatted) return;
	// Mimic the currency formatting used by Frappe print formats for amount
	// fields, while leaving identifiers and plain values untouched.
	obj.get_formatted = function (field) {
		const value = this?.[field];
		if (
			/(amount|total|rate|paid|change)/i.test(field) &&
			typeof frappe !== "undefined" &&
			frappe.utils?.fmt_money
		) {
			return frappe.utils.fmt_money(value, undefined, this.currency);
		}
		return value;
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

function parseTaxRates(raw) {
	if (!raw) return {};
	if (typeof raw === "object") return raw;
	try {
		return JSON.parse(raw) || {};
	} catch {
		return {};
	}
}

function prepareOfflineDoc(invoice, terms) {
	const doc = {
		...invoice,
		terms: invoice.terms || terms,
		terms_and_conditions: invoice.terms_and_conditions || terms,
	};

	doc.name = doc.name || "Offline / Pending Sync";
	doc.fbr_invoice_no =
		doc.fbr_invoice_no ||
		doc.custom_fbr_fiscal_invoice_number ||
		doc.custom_fbr_invoice_no ||
		doc.fiscal_invoice_number ||
		doc.InvoiceNumber ||
		"";
	doc.owner = doc.owner || (typeof frappe !== "undefined" ? frappe.session?.user : "") || "";
	doc.customer_name = doc.customer_name || doc.customer || "";
	doc.posting_date = doc.posting_date || new Date().toISOString().slice(0, 10);
	doc.posting_time = doc.posting_time || new Date().toTimeString().slice(0, 8);
	doc.total_qty = (doc.items || []).reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
	doc.total_taxes_and_charges =
		doc.total_taxes_and_charges ??
		(doc.taxes || []).reduce((sum, tax) => sum + (parseFloat(tax.tax_amount) || 0), 0);
	doc.net_total = doc.net_total ?? doc.total ?? 0;
	doc.paid_amount = computePaidAmount(doc);
	doc.change_amount =
		doc.change_amount ??
		Math.max(0, doc.paid_amount - (parseFloat(doc.rounded_total ?? doc.grand_total) || 0));

	const inclusive = (doc.taxes || []).some((tax) => Number(tax.included_in_print_rate) === 1);
	doc.items = (doc.items || []).map((source) => {
		const item = { ...source };
		const amount = parseFloat(item.amount) || 0;
		const rates = Object.values(parseTaxRates(item.item_tax_rate));
		const itemTax = rates.reduce((sum, rate) => {
			const numericRate = parseFloat(rate) || 0;
			return (
				sum +
				(inclusive ? (amount * numericRate) / (100 + numericRate) : (amount * numericRate) / 100)
			);
		}, 0);
		item.item_tax_amount = item.item_tax_amount ?? itemTax;
		item.tax_amount = item.tax_amount ?? item.item_tax_amount;
		item.final_amount = item.final_amount ?? (inclusive ? amount : amount + itemTax);
		item.amount_after_tax = item.amount_after_tax ?? item.final_amount;
		return item;
	});

	return doc;
}

function localizeOfflineAssets(rendered, doc) {
	let html = rendered.replace(
		/https:\/\/pbs\.twimg\.com\/profile_images\/[^"'\s>]+/g,
		"/assets/posawesome/images/fbr_loog.png",
	);

	if (doc.fbr_invoice_no) {
		const qrSvg = generateQRCodeSVG(doc.fbr_invoice_no);
		const qrData = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`;
		html = html.replace(/https:\/\/api\.qrserver\.com\/v1\/create-qr-code\/\?[^"'\s>]+/g, qrData);
	}

	return html;
}

function ensureHTMLDocument(rendered) {
	if (/<!doctype|<html[\s>]/i.test(rendered)) return rendered;
	const leadingStyles = rendered.match(/^\s*(?:<style[\s\S]*?<\/style>\s*)+/i)?.[0] || "";
	const markup = leadingStyles ? rendered.slice(leadingStyles.length) : rendered;
	const content = /class=["'][^"']*\bprint-format\b/i.test(markup)
		? markup
		: `<div class="print-format">${markup}</div>`;
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Receipt</title>
${leadingStyles}
<style>
	@page { margin: 0; }
	html, body { margin: 0; padding: 0; background: #fff; }
	.print-format { box-sizing: border-box; margin: 0 auto; font-size: 9pt; color: #000; }
	.text-right { text-align: right; }
	.text-center { text-align: center; }
	.text-left { text-align: left; }
	table { border-collapse: collapse; }
	.table { width: 100%; max-width: 100%; margin: 20px 0; }
	.table > thead > tr > th, .table > tbody > tr > th,
	.table > tfoot > tr > th, .table > thead > tr > td,
	.table > tbody > tr > td, .table > tfoot > tr > td {
		padding: 8px; line-height: 1.42857143; vertical-align: top;
		border-top: 1px solid #d1d8dd;
	}
	.table > thead > tr > th { vertical-align: bottom; border-bottom: 2px solid #d1d8dd; }
	.table > thead:first-child > tr:first-child > th { border-top: 0; }
	.table-condensed > thead > tr > th, .table-condensed > tbody > tr > th,
	.table-condensed > tfoot > tr > th, .table-condensed > thead > tr > td,
	.table-condensed > tbody > tr > td, .table-condensed > tfoot > tr > td { padding: 5px; }
	table.no-border, table.no-border td { border: 0; }
	.print-format p { margin: 3px 0; }
	.print-format img { max-width: 100%; }
</style>
</head>
<body>${content}</body>
</html>`;
}

import kjua from "kjua";

function generateQRCodeSVG(data) {
	return kjua({
		render: "svg",
		text: data,
		size: 100,
		fill: "#000",
		back: "#fff",
		rounded: 0,
		quiet: 0,
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
			const marker =
				invoice.posa_show_custom_name_marker_on_print && it.name_overridden ? " (custom)" : "";
			const sn = it.serial_no
				? `<div class="serial">SR.No: ${it.serial_no.replace(/\n/g, ", ")}</div>`
				: "";

			return `
            <!-- Heading Row (ONCE) -->
            ${
				i === 0
					? `
            <tr class="heading-row">
                <th width="20%" style="padding:0px !important; border:none;">Item</th>
				<th width="10%" style="padding:0px !important; border:none;" class="text-right">Price</th>
                <th width="10%" style="padding:0px !important; border:none;" class="text-right">Dis</th>
				<th width="10%" style="padding:0px !important; border:none;" class="text-right">Qty</th>
                <th width="10%" style="padding:0px !important; border:none;" class="text-right">Rate</th>
                <th width="10%" style="padding:0px !important; border:none;" class="text-right">Amount</th>
            </tr>
            `
					: ""
			}

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

	return `
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
    font-size: 7px;
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
    width: 90px;
}

</style>
</head>

<body>
<div class="print-format">

    <!-- LOGO -->
    <div style="text-align: left;">
        <img src="/files/aaaaaaaaaa5fe70e.jpg" class="logo">
    </div>

    <hr>

    <!-- HEADER INFO -->
    <p>
        POS No: ${invoice.name}<br>
        Cashier: ${invoice.owner}<br>
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
				.map(
					(item) => `
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
            `,
				)
				.join("")}
        </tbody>
    </table>

    <hr>

    <!-- TOTALS SECTION -->
    <table class="no-border">
        <tr>
            <td>Net Total</td>
            <td class="text-right">${invoice.total}</td>
        </tr>

		${invoice.taxes
			?.map(
				(tax) => `
			<tr>
				<td>${tax.description || tax.account_head || "Tax"}${tax.rate ? ` @${tax.rate}%` : ""}</td>
				<td class="text-right">${tax.tax_amount}</td>
			</tr>
		`,
			)
			.join("")}

        ${
			invoice.discount_amount
				? `
        <tr>
            <td>Discount</td>
            <td class="text-right">-${invoice.discount_amount}</td>
        </tr>`
				: ""
		}

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
    ${
		qrSVG
			? `
    <div style="text-align:center; margin-top:5px;">
        ${qrSVG.replace("<svg", '<svg class="qr-img"')}
    </div>`
			: ""
	}

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
	const doc = prepareOfflineDoc(invoice, terms);
	attachFormatter(doc);
	(doc.items || []).forEach(attachFormatter);
	(doc.taxes || []).forEach(attachFormatter);

	if (!template) {
		console.warn("No offline print template cached; using fallback template");
		return defaultOfflineHTML(doc, doc.terms_and_conditions);
	}

	try {
		const env = nunjucks.configure({ autoescape: false });
		const decorateDict = (value) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return value;
			Object.defineProperty(value, "items", {
				value: () => Object.entries(value).filter(([key]) => key !== "items"),
				enumerable: false,
			});
			return value;
		};
		env.addGlobal("json", { loads: (value) => decorateDict(parseTaxRates(value)) });
		env.addGlobal("namespace", (values = {}) => ({ ...values }));
		env.addGlobal("dict_update", (target, values) => {
			Object.assign(target, values);
			return false;
		});
		env.addGlobal("dict_set", (target, key, value) => {
			target[key] = value;
			return target;
		});
		env.addGlobal("max", (...values) => Math.max(...values.map((value) => Number(value) || 0)));
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
			_: typeof frappe !== "undefined" && frappe._ ? frappe._ : (t) => t,
			frappe: {
				db: {
					get_value: (_doctype, name, fieldname) => (fieldname === "name" ? name : ""),
					sql: () => [],
				},
				get_list: () => [],
				utils: {
					fmt_money: (value, precision = 2, currency = doc.currency) => {
						if (precision && typeof precision === "object") {
							currency = precision.currency || doc.currency;
							precision = precision.precision ?? 2;
						}
						if (typeof frappe !== "undefined" && frappe.utils?.fmt_money) {
							return frappe.utils.fmt_money(value, precision, currency);
						}
						const number = Number(value) || 0;
						return currency
							? `${currency} ${number.toLocaleString(undefined, {
									minimumFractionDigits: precision,
									maximumFractionDigits: precision,
								})}`
							: number.toFixed(precision);
					},
					formatdate: (value, format) => {
						if (typeof frappe !== "undefined" && frappe.utils?.formatdate) {
							return frappe.utils.formatdate(value, format);
						}
						if (format === "dd-MM-yyyy" && /^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
							const [year, month, day] = value.split("-");
							return `${day}-${month}-${year}`;
						}
						return value || "";
					},
					format_time: (value) => {
						if (typeof frappe !== "undefined" && frappe.utils?.format_time) {
							return frappe.utils.format_time(value);
						}
						return value || "";
					},
				},
			},
		};
		return ensureHTMLDocument(localizeOfflineAssets(env.renderString(template, context), doc));
	} catch (e) {
		console.error("Failed to render offline invoice", e);
		return defaultOfflineHTML(doc, doc.terms_and_conditions);
	}
}
