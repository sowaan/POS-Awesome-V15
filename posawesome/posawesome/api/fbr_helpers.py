# apps/posawesome/posawesome/api/fbr_helpers.py
import frappe


@frappe.whitelist()
def is_fbr_installed():
    """
    Check if FBR Fiscal Bridge app is installed.
    Returns True if installed, False otherwise.
    """
    installed_apps = frappe.get_installed_apps()
    return "fbr_fiscal_bridge" in installed_apps