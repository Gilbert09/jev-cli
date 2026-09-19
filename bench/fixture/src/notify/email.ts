import { withRetry } from "../util/retry.js";
export async function sendEmail(to: string, subject: string, body: string) {
  await withRetry(async () => {
    const res = await fetch("https://mail.internal/send", { method: "POST", body: JSON.stringify({ to, subject, body }) });
    if (!res.ok) throw Object.assign(new Error("send failed"), { status: res.status });
  });
}
