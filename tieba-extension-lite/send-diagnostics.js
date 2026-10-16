// Only numeric protocol fields are retained; server text may echo private content.
const numericFields = new Set([
  "err_code", "error_code", "errno", "no", "code", "status", "role", "msgid", "time",
  "auto_risk_control_status", "display_tips", "remain_msg_num", "send_msg_num",
  "ping_interval", "ack_enable",
]);

function summarizeBody(data, depth = 0) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = {};
  const values = {};
  for (const key of Object.keys(data).slice(0, 80)) {
    if (!/^[a-z_][a-z0-9_]{0,63}$/i.test(key)) continue;
    const value = data[key];
    fields[key] = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (numericFields.has(key) && (typeof value === "boolean"
      || typeof value === "number" && Number.isFinite(value)
      || typeof value === "string" && /^-?\d{1,20}$/.test(value))) values[key] = value;
  }
  const result = { fields, values };
  if (depth < 2) {
    for (const key of ["response_params", "tips_new", "tips"]) {
      if (data[key] && typeof data[key] === "object" && !Array.isArray(data[key])) {
        result[key] = summarizeBody(data[key], depth + 1);
      }
    }
  }
  return result;
}

export function summarizeReply(serviceId, methodId, response) {
  const meta = response?.meta;
  return {
    at: Date.now(), serviceId, methodId,
    outcome: response ? "reply" : "timeout",
    rpcErrorCode: typeof meta?.errorCode === "number" ? meta.errorCode : null,
    rpcErrorTextPresent: !!meta?.errorText,
    rpcErrorTextIsSuccess: meta?.errorText === "success",
    bodyKind: response?.lcm?.kind || null,
    body: response?.lcm?.kind === "json" ? summarizeBody(response.lcm.data) : null,
  };
}
