// XML text helpers shared by the 3MF writers: escaping and number formatting.
//
// Numbers are written as plain decimals, never in scientific notation: the 3MF
// schema's ST_Number is a fixed-point decimal and the Bambu Studio reader goes
// through strtod on the attribute text, so "1e-7" would be legal there but is
// not in every consumer. Trailing zeros are trimmed so the file stays small.

export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
}

/**
 * Fixed-point decimal with at most `decimals` fractional digits, trailing
 * zeros trimmed, no exponent, no "-0". `decimals` defaults to 6, which is
 * finer than the float32 spacing of any coordinate under 1000 mm, so two
 * distinct vertices never collapse into one on the way through the file.
 */
export function fmtNum(value: number, decimals = 6): string {
  if (!Number.isFinite(value)) {
    throw new Error(`cannot write a non-finite number: ${value}`);
  }
  if (Math.abs(value) >= 1e21) {
    // toFixed switches to an exponent here; nothing in a model is this large,
    // but the contract of this function is "never an exponent".
    return BigInt(Math.round(value)).toString();
  }
  let text = value.toFixed(decimals);
  if (text.indexOf(".") >= 0) {
    text = text.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (text === "-0" || text === "") {
    text = "0";
  }
  return text;
}

export function fmtInt(value: number): string {
  if (!Number.isInteger(value)) {
    throw new Error(`not an integer: ${value}`);
  }
  return String(value);
}

/** `key="value"` pairs, in the order given, each value escaped. */
export function attrs(pairs: ReadonlyArray<readonly [string, string | number]>): string {
  let out = "";
  for (const [key, value] of pairs) {
    out += ` ${key}="${escapeAttr(typeof value === "number" ? fmtNum(value) : value)}"`;
  }
  return out;
}

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** A 3MF `transform` attribute: row-major 4x3, the identity by default. */
export function transform3mf(tx = 0, ty = 0, tz = 0): string {
  return `1 0 0 0 1 0 0 0 1 ${fmtNum(tx)} ${fmtNum(ty)} ${fmtNum(tz)}`;
}

/** Bambu `model_settings.config` `matrix` value: row-major 4x4 identity. */
export const IDENTITY_MATRIX_4X4 = "1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1";
