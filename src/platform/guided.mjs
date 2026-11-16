import { escapeHtml as h } from "../public-shell.mjs";
import { IntakeError } from "../demo/backend.mjs";

/**
 * UFR-017 guided navigation and UFR-018 guided statutory forms
 * (demonstration). Field sets are modeled loosely on common federal filing
 * elements (for example a "sum certain" for tort claim notices). They are
 * not official forms (such as SF-95) and are not legal advice.
 */
export const GUIDE = [
  { type: "administrative-claim", purpose: "Ask an agency to pay or provide a benefit", detail: "Benefit, payment or reimbursement requests." },
  { type: "administrative-appeal", purpose: "Appeal an agency decision", detail: "You received a decision and want it reviewed." },
  { type: "records-request", purpose: "Request government records", detail: "Records-access (FOIA-style) requests." },
  { type: "records-appeal", purpose: "Appeal a records-request response", detail: "Withholding, fees, search adequacy or delay." },
  { type: "tort-claim-notice", purpose: "Claim for damage or injury caused by an agency", detail: "Property damage or personal injury; a sum certain is required." },
  { type: "complaint", purpose: "Complain about conduct or treatment", detail: "Civil-rights or service complaints." },
  { type: "petition", purpose: "Petition an agency to act", detail: "Ask for a rule, policy or action." },
  { type: "general-correspondence", purpose: "Something else", detail: "General correspondence to a fictional agency." },
];

const date = (label, required = false) => ({ kind: "date", label, required });
const textf = (label, required = false, max = 500) => ({ kind: "text", label, required, max });
const choice = (label, options, required = false) => ({ kind: "choice", label, options, required });
const money = (label, required = false) => ({ kind: "money", label, required });

export const SCHEMAS = {
  "administrative-claim": { claimCategory: choice("Claim category", ["benefit", "payment", "reimbursement", "other"], true), amountClaimed: money("Amount claimed (USD, if any)"), eventDate: date("Date of the event giving rise to the claim") },
  "administrative-appeal": { decisionReference: textf("Decision or case reference", true, 120), decisionDate: date("Date of the decision", true), reliefSought: textf("Relief sought", true) },
  "records-request": { recordsDescription: textf("Describe the records", true, 2000), dateRangeStart: date("Records from"), dateRangeEnd: date("Records to"), feeWaiver: choice("Fee waiver requested", ["no", "yes"]), expedited: choice("Expedited processing requested", ["no", "yes"]) },
  "records-appeal": { requestReference: textf("Original request tracking number", true, 40), determinationDate: date("Date of the response", true), appealBasis: choice("Basis of appeal", ["withholding", "adequacy_of_search", "fees", "delay", "other"], true) },
  "tort-claim-notice": { incidentDate: date("Date of incident", true), incidentLocation: textf("Location of incident", true, 300), injuryType: choice("Type of claim", ["property", "personal_injury", "both"], true), sumCertain: money("Sum certain claimed (USD)", true) },
  complaint: { complaintSubject: textf("What is the complaint about?", true, 300), incidentDate: date("Date of incident") },
  petition: { requestedAction: textf("Action requested", true, 1000) },
  "general-correspondence": {},
};

export const structuredForms = {
  render(filingType, values = {}) {
    const schema = SCHEMAS[filingType];
    if (!schema || !Object.keys(schema).length) return "";
    return `<fieldset><legend>Details for ${h(filingType)}</legend><input type="hidden" name="guided" value="yes">` +
      Object.entries(schema).map(([name, f]) => {
        const id = `sf-${name}`; const v = values[name] ?? "";
        const label = `<label for="${id}">${h(f.label)}${f.required ? "" : " (optional)"}</label>`;
        if (f.kind === "choice") return label + `<select id="${id}" name="${name}"${f.required ? " required" : ""}>${f.required ? "" : '<option value="">Not specified</option>'}${f.options.map((o) => `<option value="${h(o)}"${v === o ? " selected" : ""}>${h(o.replace(/_/g, " "))}</option>`).join("")}</select>`;
        if (f.kind === "date") return label + `<input id="${id}" name="${name}" type="date" value="${h(v)}"${f.required ? " required" : ""}>`;
        if (f.kind === "money") return label + `<input id="${id}" name="${name}" inputmode="decimal" pattern="[0-9]+(\\.[0-9]{2})?" value="${h(v)}"${f.required ? " required" : ""}>`;
        return label + `<input id="${id}" name="${name}" maxlength="${f.max}" value="${h(v)}"${f.required ? " required" : ""}>`;
      }).join("") + `</fieldset>`;
  },
  /** Validates type-specific fields. Strict (required fields enforced) when submitted from a guided form. */
  parse(filingType, fields, { lenient = false } = {}) {
    const schema = SCHEMAS[filingType];
    if (!schema) return {};
    const strict = !lenient && fields.guided === "yes";
    const out = {};
    for (const [name, f] of Object.entries(schema)) {
      const raw = typeof fields[name] === "string" ? fields[name].trim() : "";
      if (!raw) { if (strict && f.required) throw new IntakeError(`missing_${name}`); continue; }
      if (f.kind === "date") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw + "T00:00:00Z"))) throw new IntakeError(`invalid_${name}`);
        if (Date.parse(raw + "T00:00:00Z") > Date.now() + 86_400_000) throw new IntakeError(`invalid_${name}`);
      } else if (f.kind === "money") {
        if (!/^\d{1,9}(\.\d{2})?$/.test(raw) || Number(raw) <= 0) throw new IntakeError(`invalid_${name}`);
      } else if (f.kind === "choice") {
        if (!f.options.includes(raw)) throw new IntakeError(`invalid_${name}`);
      } else if (raw.length > f.max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)) throw new IntakeError(`invalid_${name}`);
      out[name] = raw;
    }
    if (out.dateRangeStart && out.dateRangeEnd && out.dateRangeStart > out.dateRangeEnd) throw new IntakeError("invalid_dateRangeEnd");
    return out;
  },
};
