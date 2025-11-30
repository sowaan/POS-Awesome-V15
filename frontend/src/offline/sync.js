/* global frappe */
import { memory, resetOfflineState, setLastSyncTotals, MAX_QUEUE_ITEMS, reduceCacheUsage } from "./cache.js";
import { persist } from "./core.js";
import { updateLocalStock } from "./stock.js";
import renderOfflineInvoiceHTML from "../offline_print_template.js";

// Add this helper function at the top of your file (or before saveOfflineInvoice)
function deepCloneSerializable(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj; // Return primitives as-is
    }
    if (Array.isArray(obj)) {
        return obj.map(deepCloneSerializable); // Recurse for arrays
    }
    const cloned = {};
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const value = obj[key];
            // Skip functions, undefined, and other non-serializable types
            if (typeof value !== 'function' && value !== undefined) {
                cloned[key] = deepCloneSerializable(value);
            }
        }
    }
    return cloned;
}
// Flag to avoid concurrent invoice syncs which can cause duplicate submissions
let invoiceSyncInProgress = false;
// Paste printOfflineInvoice here
async function printOfflineInvoice(invoice, fiscalPayload) {
    const html = await renderOfflineInvoiceHTML(invoice);
    const w = window.open();
    if (!w) {
        console.error("Failed to open print window (popup blocker?)");
        return;
    }
    w.document.write(html);
    w.document.close();

    // Wait for document + images with better handling
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            console.warn("Print timeout reached, forcing print.");
            w.print();
            setTimeout(() => w.close(), 1000); // Close after a delay
            resolve();
        }, 5000); // 5-second timeout as fallback

        w.onload = () => {
            clearTimeout(timeout); // Cancel timeout if load succeeds
            const imgs = w.document.images;
            let pending = 0;

            // Count only unloaded images
            [...imgs].forEach(img => {
                if (!img.complete) {
                    pending++;
                    img.onload = img.onerror = () => {
                        if (--pending === 0) {
                            w.print();
                            setTimeout(() => w.close(), 1000); // Close after print
                            resolve();
                        }
                    };
                }
            });

            // If no pending images (all already loaded), print immediately
            if (pending === 0) {
                w.print();
                setTimeout(() => w.close(), 1000);
                resolve();
            }
        };

        // Handle window close (optional, in case user closes early)
        w.onbeforeunload = () => {
            clearTimeout(timeout);
            resolve(); // Allow the function to proceed
        };
    });
}



export async function saveOfflineInvoice(entry, print = false) {
    console.log("Attempting to save offline invoice", entry);

    // Validate invoice items
    if (!entry.invoice || !Array.isArray(entry.invoice.items) || !entry.invoice.items.length) {
        throw new Error("Cart is empty. Add items before saving.");
    }

    const key = "offline_invoices";
    const entries = memory.offline_invoices || [];

    let cleanEntry;
    try {
		cleanEntry = deepCloneSerializable(entry);
    } catch (e) {
        console.error("Failed to serialize offline invoice", e);
        throw e;
    }

    console.log("Saving offline invoice", cleanEntry);

    // Build fiscal payload
    let fiscalPayload = {};
    try {
        const invoice = cleanEntry.invoice;
        const posID = invoice.pos_profile?.custom_pos_id || "110014";
        const totalTaxes = parseFloat(invoice.total_taxes_and_charges || 0);
        const netTotal = parseFloat(invoice.net_total || invoice.grand_total || 0);
        const taxRate = netTotal ? Math.round((totalTaxes / netTotal) * 100) : 0;

        let totalQuantity = 0;
        const items = invoice.items.map(item => {
            const rateAfterDiscount = parseFloat(item.rate || 0) * (1 - ((parseFloat(invoice.additional_discount_percentage) || 0) / 100));
            const amountAfterDiscount = parseFloat(item.qty || 0) * rateAfterDiscount;
            const taxCharged = amountAfterDiscount * taxRate / 100;

            totalQuantity += parseFloat(item.qty || 0);
            const pctCode = item.custom_pct_code || "11001010";

            return {
                ItemCode: item.item_code,
                ItemName: item.item_name,
                Quantity: parseFloat(item.qty || 0),
                PCTCode: pctCode,
                TaxRate: taxRate,
                SaleValue: rateAfterDiscount,
                TotalAmount: amountAfterDiscount,
                TaxCharged: taxCharged,
                Discount: 0.0,
                FurtherTax: 0.0,
                InvoiceType: 2,
                RefUSIN: null
            };
        });

        fiscalPayload = {
            InvoiceNumber: "",
            POSID: posID,
            USIN: "SI-TEST-001",
            DateTime: `${invoice.posting_date || new Date().toISOString().split("T")[0]} ${invoice.posting_time || "00:00:00"}`,
            BuyerName: invoice.customer || "Walkin",
            BuyerNTN: invoice.customer_ntn || "",
            TotalBillAmount: parseFloat(invoice.grand_total || 0),
            TotalQuantity: totalQuantity,
            TotalSaleValue: parseFloat(invoice.net_total || 0),
            TotalTaxCharged: totalTaxes,
            Discount: 0.0,
            FurtherTax: 0.0,
            PaymentMode: 1,
            RefUSIN: null,
            InvoiceType: 1,
            Items: items
        };

        console.log("Fiscal payload ready:", fiscalPayload);

        // Call Local Fiscal Proxy
        try {
            const res = await fetch("http://localhost:8525/api/get_fiscal_invoice", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(fiscalPayload)
            });

            let data;
            try {
                data = await res.json();
            } catch (e) {
                console.error("Fiscal proxy returned invalid JSON:", await res.text());
                data = { status: "error", message: "Invalid JSON from fiscal proxy" };
            }

            if (data.status === "success" && data.fiscal?.InvoiceNumber) {
                // Update invoice with fiscal number
                cleanEntry.invoice.custom_fbr_fiscal_invoice_number = data.fiscal.InvoiceNumber;
                console.log("Fiscal Invoice Number:", data.fiscal.InvoiceNumber);

                // Only print if print flag is true
                if (print) {
                    await printOfflineInvoice(cleanEntry.invoice, data.fiscal);
                }
            } else {
                console.error("Fiscal Error:", data.message || data);
            }

        } catch (err) {
            console.error("Cannot reach Local Fiscal Proxy (is proxy.py running?)", err);
        }

    } catch (err) {
        console.error("Error building fiscal payload:", err);
    }

    // Normal offline save
    entries.push(cleanEntry);
    if (entries.length > MAX_QUEUE_ITEMS) {
        entries.splice(0, entries.length - MAX_QUEUE_ITEMS);
    }
    memory.offline_invoices = entries;
    persist(key, memory.offline_invoices);

    if (entry.invoice?.items) {
        updateLocalStock(entry.invoice.items);
    }

    console.log("Offline invoice saved successfully.");
}

export function isOffline() {
	// Use cached data when running offline
	if (typeof window === "undefined") {
		// Not in a browser (SSR/Node), assume online (or handle explicitly if needed)
		return memory.manual_offline || false;
	}

	const { protocol, hostname, navigator } = window;
	const online = navigator.onLine;

	const serverOnline = typeof window.serverOnline === "boolean" ? window.serverOnline : true;

	const isIpAddress = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
	const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
	const isDnsName = !isIpAddress && !isLocalhost;

	if (memory.manual_offline) {
		return true;
	}

	if (protocol === "https:" && isDnsName) {
		return !online || !serverOnline;
	}

	return !online || !serverOnline;
}

export function getOfflineInvoices() {
	return memory.offline_invoices;
}

export function clearOfflineInvoices() {
	memory.offline_invoices = [];
	persist("offline_invoices", memory.offline_invoices);
}

export function deleteOfflineInvoice(index) {
	if (Array.isArray(memory.offline_invoices) && index >= 0 && index < memory.offline_invoices.length) {
		memory.offline_invoices.splice(index, 1);
		persist("offline_invoices", memory.offline_invoices);
	}
}

export function getPendingOfflineInvoiceCount() {
	return memory.offline_invoices.length;
}

export function saveOfflinePayment(entry) {
	const key = "offline_payments";
	const entries = memory.offline_payments;
	// Strip down POS Profile to essential fields to avoid
	// serialization errors from complex reactive objects
	if (entry?.args?.payload?.pos_profile) {
		const profile = entry.args.payload.pos_profile;
		entry.args.payload.pos_profile = {
			posa_use_pos_awesome_payments: profile.posa_use_pos_awesome_payments,
			posa_allow_make_new_payments: profile.posa_allow_make_new_payments,
			posa_allow_reconcile_payments: profile.posa_allow_reconcile_payments,
			posa_allow_mpesa_reconcile_payments: profile.posa_allow_mpesa_reconcile_payments,
			posa_force_server_items: profile.posa_force_server_items,
			cost_center: profile.cost_center,
			posa_cash_mode_of_payment: profile.posa_cash_mode_of_payment,
			name: profile.name,
		};
	}
	let cleanEntry;
	try {
		cleanEntry = JSON.parse(JSON.stringify(entry));
	} catch (e) {
		console.error("Failed to serialize offline payment", e);
		throw e;
	}
	entries.push(cleanEntry);
	if (entries.length > MAX_QUEUE_ITEMS) {
		entries.splice(0, entries.length - MAX_QUEUE_ITEMS);
	}
	memory.offline_payments = entries;
	persist(key, memory.offline_payments);
}

export function getOfflinePayments() {
	return memory.offline_payments;
}

export function clearOfflinePayments() {
	memory.offline_payments = [];
	persist("offline_payments", memory.offline_payments);
}

export function deleteOfflinePayment(index) {
	if (Array.isArray(memory.offline_payments) && index >= 0 && index < memory.offline_payments.length) {
		memory.offline_payments.splice(index, 1);
		persist("offline_payments", memory.offline_payments);
	}
}

export function getPendingOfflinePaymentCount() {
	return memory.offline_payments.length;
}

export function saveOfflineCustomer(entry) {
	const key = "offline_customers";
	const entries = memory.offline_customers;
	// Serialize to avoid storing reactive objects that IndexedDB
	// cannot clone.
	let cleanEntry;
	try {
		cleanEntry = JSON.parse(JSON.stringify(entry));
	} catch (e) {
		console.error("Failed to serialize offline customer", e);
		throw e;
	}
	entries.push(cleanEntry);
	if (entries.length > MAX_QUEUE_ITEMS) {
		entries.splice(0, entries.length - MAX_QUEUE_ITEMS);
	}
	memory.offline_customers = entries;
	persist(key, memory.offline_customers);
}

export function updateOfflineInvoicesCustomer(oldName, newName) {
	let updated = false;
	const invoices = memory.offline_invoices || [];
	invoices.forEach((inv) => {
		if (inv.invoice && inv.invoice.customer === oldName) {
			inv.invoice.customer = newName;
			if (inv.invoice.customer_name) {
				inv.invoice.customer_name = newName;
			}
			updated = true;
		}
	});
	if (updated) {
		memory.offline_invoices = invoices;
		persist("offline_invoices", memory.offline_invoices);
	}
}

export function getOfflineCustomers() {
	return memory.offline_customers;
}

export function clearOfflineCustomers() {
	memory.offline_customers = [];
	persist("offline_customers", memory.offline_customers);
}

// Add sync function to clear local cache when invoices are successfully synced
export async function syncOfflineInvoices() {
	// Prevent concurrent syncs which can lead to duplicate submissions
	if (invoiceSyncInProgress) {
		return { pending: getPendingOfflineInvoiceCount(), synced: 0, drafted: 0 };
	}
	invoiceSyncInProgress = true;
	try {
		// Ensure any offline customers are synced first so that invoices
		// referencing them do not fail during submission
		await syncOfflineCustomers();

		const invoices = getOfflineInvoices();
		if (!invoices.length) {
			// No invoices to sync; clear last totals to avoid repeated messages
			const totals = { pending: 0, synced: 0, drafted: 0 };
			setLastSyncTotals(totals);
			return totals;
		}
		if (isOffline()) {
			// When offline just return the pending count without attempting a sync
			return { pending: invoices.length, synced: 0, drafted: 0 };
		}

		const failures = [];
		let synced = 0;
		let drafted = 0;

		for (const inv of invoices) {
			try {
				await frappe.call({
					method: "posawesome.posawesome.api.invoices.submit_invoice",
					args: {
						invoice: inv.invoice,
						data: inv.data,
					},
				});
				synced++;
			} catch (error) {
				console.error("Failed to submit invoice, saving as draft", error);
				try {
					await frappe.call({
						method: "posawesome.posawesome.api.invoices.update_invoice",
						args: { data: inv.invoice },
					});
					drafted += 1;
				} catch (draftErr) {
					console.error("Failed to save invoice as draft", draftErr);
					failures.push(inv);
				}
			}
		}

		// Reset saved invoices and totals after successful sync
		if (synced > 0) {
			resetOfflineState();
		}

		const pendingLeft = failures.length;

		if (pendingLeft) {
			memory.offline_invoices = failures;
			persist("offline_invoices", memory.offline_invoices);
		} else {
			clearOfflineInvoices();
			if (synced > 0 && drafted === 0) {
				reduceCacheUsage();
			}
		}

		const totals = { pending: pendingLeft, synced, drafted };
		if (pendingLeft || drafted) {
			// Persist totals only if there are invoices still pending or drafted
			setLastSyncTotals(totals);
		} else {
			// Clear totals so success message only shows once
			setLastSyncTotals({ pending: 0, synced: 0, drafted: 0 });
		}
		return totals;
	} finally {
		invoiceSyncInProgress = false;
	}
}

export async function syncOfflineCustomers() {
	const customers = getOfflineCustomers();
	if (!customers.length) {
		return { pending: 0, synced: 0 };
	}
	if (isOffline()) {
		return { pending: customers.length, synced: 0 };
	}

	const failures = [];
	let synced = 0;

	for (const cust of customers) {
		try {
			const result = await frappe.call({
				method: "posawesome.posawesome.api.customers.create_customer",
				args: cust.args,
			});
			synced++;
			if (
				result &&
				result.message &&
				result.message.name &&
				result.message.name !== cust.args.customer_name
			) {
				updateOfflineInvoicesCustomer(cust.args.customer_name, result.message.name);
			}
		} catch (error) {
			console.error("Failed to create customer", error);
			failures.push(cust);
		}
	}

	if (failures.length) {
		memory.offline_customers = failures;
		persist("offline_customers", memory.offline_customers);
	} else {
		clearOfflineCustomers();
	}

	return { pending: failures.length, synced };
}

export async function syncOfflinePayments() {
	await syncOfflineCustomers();

	const payments = getOfflinePayments();
	if (!payments.length) {
		return { pending: 0, synced: 0 };
	}
	if (isOffline()) {
		return { pending: payments.length, synced: 0 };
	}

	const failures = [];
	let synced = 0;

	for (const pay of payments) {
		try {
			await frappe.call({
				method: "posawesome.posawesome.api.payment_entry.process_pos_payment",
				args: pay.args,
			});
			synced++;
		} catch (error) {
			console.error("Failed to submit payment", error);
			failures.push(pay);
		}
	}

	if (failures.length) {
		memory.offline_payments = failures;
		persist("offline_payments", memory.offline_payments);
	} else {
		clearOfflinePayments();
	}

	return { pending: failures.length, synced };
}