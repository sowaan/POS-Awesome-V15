/* global frappe */
import { getOpeningStorage, setPrintTemplate, setTermsAndConditions } from "../offline/index.js";

export async function cachePrintTemplateAndTerms(profile) {
	if (!profile || typeof frappe === "undefined" || !navigator.onLine) return;

	try {
		// Online printing prefers print_format_for_online, so cache that same
		// format for locally-created invoices as well.
		const printFormat = profile.print_format_for_online || profile.print_format;
		if (printFormat) {
			const pf = await frappe.call({
				method: "frappe.client.get_value",
				args: {
					doctype: "Print Format",
					fieldname: ["html", "css"],
					filters: { name: printFormat },
				},
			});
			if (pf.message?.html) {
				const css = pf.message.css ? `<style>${pf.message.css}</style>` : "";
				setPrintTemplate(`${css}${pf.message.html}`);
			}
		}
	} catch (e) {
		// Keep the last successfully cached template if a refresh fails. It is
		// still a closer match than replacing it with the generic fallback.
		console.error("Failed to fetch print format", e);
	}

	try {
		const termsName = profile.tc_name || profile.terms_and_conditions;
		if (termsName) {
			const tc = await frappe.call({
				method: "frappe.client.get_value",
				args: {
					doctype: "Terms and Conditions",
					fieldname: "terms",
					filters: { name: termsName },
				},
			});
			if (tc.message && tc.message.terms) {
				setTermsAndConditions(tc.message.terms);
			}
		}
	} catch (e) {
		console.error("Failed to fetch terms and conditions", e);
	}
}

export async function ensurePosProfile() {
	const bootProfile = frappe?.boot?.pos_profile;
	if (bootProfile && bootProfile.warehouse && bootProfile.selling_price_list) {
		await cachePrintTemplateAndTerms(bootProfile);
		return bootProfile;
	}
	try {
		const res = await frappe.call({
			method: "posawesome.posawesome.api.utils.get_active_pos_profile",
			args: { user: frappe.session.user },
		});
		if (res.message) {
			frappe.boot.pos_profile = res.message;
			await cachePrintTemplateAndTerms(res.message);
			return res.message;
		}
	} catch (e) {
		console.error("Failed to fetch active POS profile", e);
	}
	const cached = getOpeningStorage();
	if (cached && cached.pos_profile) {
		await cachePrintTemplateAndTerms(cached.pos_profile);
		return cached.pos_profile;
	}
	await cachePrintTemplateAndTerms(bootProfile);
	return bootProfile || null;
}
