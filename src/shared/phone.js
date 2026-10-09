/**
 * Phone number normalisation + validation. Pure functions, no chrome APIs,
 * so they can be reused by the content script and tested in Node.
 */
import { DEFAULT_COUNTRY_CODE } from './config.js';

/**
 * Turns Excel-style numeric values into a plain digit string.
 * Handles real numbers (9876543210), "9876543210.0" and "9.87654321E9".
 * @param {string|number} raw
 * @returns {{digits?: string, error?: string, text?: string}} `text` is the cleaned input when no conversion applied
 */
function fromExcelNumber(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { error: 'Not a number' };
    return { digits: Math.round(raw).toString() };
  }
  const text = String(raw ?? '').trim();

  // "9876543210.0" — Excel/CSV float formatting
  const float = text.match(/^(\+?\d+)\.0+$/);
  if (float) return { text: float[1] };

  // "9.87654321E9" / "9.88E+09" — scientific notation
  const sci = text.match(/^(\d+)(?:\.(\d+))?e\+?(\d+)$/i);
  if (sci) {
    const significant = (sci[1] + (sci[2] || '')).replace(/^0+/, '').length;
    const digits = BigInt(Math.round(Number(text))).toString();
    // "9.88E+09" only kept 3 digits — the rest were rounded away by Excel.
    // Allow one implied trailing zero (spec example 9.87654321E9 → 9876543210).
    if (significant < digits.length - 1) {
      return { error: 'Digits lost in scientific notation — format the column as Text in Excel' };
    }
    return { digits };
  }
  return { text };
}

/**
 * Normalises a phone number to international digits without "+".
 * Rules: strip spaces/dashes/brackets/dots/"+"; "00" or "0" prefix dropped;
 * 10 digits → prefix country code; country code + 10 digits → keep;
 * an explicit "+" international number of 8–15 digits → keep. Otherwise invalid.
 *
 * @param {string|number} raw
 * @param {string} [countryCode]
 * @returns {{ok: true, number: string} | {ok: false, reason: string}}
 */
export function normalizePhone(raw, countryCode = DEFAULT_COUNTRY_CODE) {
  const excel = fromExcelNumber(raw);
  if (excel.error) return { ok: false, reason: excel.error };

  let s = excel.digits ?? excel.text ?? '';
  if (!s) return { ok: false, reason: 'Empty' };

  const hadPlus = s.startsWith('+');
  s = s.replace(/[\s\-(). /]/g, '').replace(/^\+/, '');
  if (!s) return { ok: false, reason: 'Empty' };
  if (!/^\d+$/.test(s)) return { ok: false, reason: 'Contains letters or symbols' };

  let international = hadPlus;
  if (s.startsWith('00')) {
    s = s.slice(2);
    international = true;
  } else if (s.startsWith('0')) {
    s = s.slice(1);
  }

  let number;
  if (!international && s.length === 10) number = countryCode + s;
  else if (s.startsWith(countryCode) && s.length === countryCode.length + 10) number = s;
  else if (international && s.length >= 8 && s.length <= 15) number = s;
  else if (s.length < 10) return { ok: false, reason: `Too short (${s.length} digits)` };
  else return { ok: false, reason: `Unexpected length (${s.length} digits)` };

  // Indian mobile numbers start with 6–9.
  if (countryCode === '91' && number.startsWith('91') && number.length === 12 && !/^[6-9]/.test(number.slice(2))) {
    return { ok: false, reason: 'Indian mobile numbers start with 6, 7, 8 or 9' };
  }
  return { ok: true, number };
}

/**
 * Splits one pasted line into name + phone. Accepts "9876543210",
 * "Name, 9876543210", "9876543210, Name" and tab/semicolon separated variants.
 * @param {string} line
 * @returns {{name: string, phone: string}}
 */
export function splitNameAndPhone(line) {
  const parts = line.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return { name: '', phone: parts[0] ?? '' };
  // The phone is the part with the most digits; everything else is the name.
  const digitCount = (p) => (p.match(/\d/g) || []).length;
  let phoneIdx = 0;
  parts.forEach((p, i) => {
    if (digitCount(p) > digitCount(parts[phoneIdx])) phoneIdx = i;
  });
  return {
    phone: parts[phoneIdx],
    name: parts.filter((_, i) => i !== phoneIdx).join(' '),
  };
}
