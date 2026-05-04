// ================================================================
// Mailer Proveedores — Cloudflare Worker v1.1.0
// ================================================================

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Mailer-Secret",
};

export default {
  // ── Solicitudes HTTP ────────────────────────────────────────────
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (env.MAILER_SECRET) {
      const sent = request.headers.get("X-Mailer-Secret") || "";
      if (sent !== env.MAILER_SECRET) {
        return json({ ok: false, error: "No autorizado" }, 401);
      }
    }

    if (request.method === "GET"  && url.pathname === "/contacts")              return json(await getContacts(env));
    if (request.method === "POST" && url.pathname === "/send")                  return handleSend(request, env);
    if (request.method === "POST" && url.pathname === "/schedule")              return handleSchedule(request, env);
    if (request.method === "GET"  && url.pathname === "/scheduled")             return handleListScheduled(env);
    if (request.method === "DELETE" && url.pathname.startsWith("/scheduled/")) {
      const id = url.pathname.slice("/scheduled/".length);
      return handleCancelScheduled(id, env);
    }

    return new Response("Not found", { status: 404 });
  },

  // ── Cron trigger: cada minuto ───────────────────────────────────
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(processScheduledEmails(env));
  }
};

// ─────────────────────────────────────────────────────────────────
// ENVÍO INMEDIATO
// ─────────────────────────────────────────────────────────────────
async function handleSend(request, env) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ ok: false, error: "Formato inválido — se esperaba multipart/form-data" }, 400);
  }

  const to      = (formData.get("to")      || "").trim();
  const subject = (formData.get("subject") || "").trim();
  const message = (formData.get("message") || "").trim();

  if (!to || !subject || !message) {
    return json({ ok: false, error: "Faltan campos: to, subject, message" }, 400);
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const destinatarios = to.split(",").map(e => e.trim()).filter(Boolean);
  for (const e of destinatarios) {
    if (!emailRe.test(e)) return json({ ok: false, error: `Email inválido: ${e}` }, 400);
  }

  const attachments = await parseAttachments(formData);
  const resData = await sendViaResend({ to: destinatarios, subject, message, attachments }, env);
  saveContacts(env, destinatarios).catch(() => {});

  return json({ ok: true, id: resData.id });
}

// ─────────────────────────────────────────────────────────────────
// PROGRAMAR ENVÍO
// ─────────────────────────────────────────────────────────────────
async function handleSchedule(request, env) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ ok: false, error: "Formato inválido" }, 400);
  }

  const to      = (formData.get("to")      || "").trim();
  const subject = (formData.get("subject") || "").trim();
  const message = (formData.get("message") || "").trim();
  const sendAt  = (formData.get("sendAt")  || "").trim();

  if (!to || !subject || !message)
    return json({ ok: false, error: "Faltan campos: to, subject, message" }, 400);
  if (!sendAt)
    return json({ ok: false, error: "Falta sendAt (fecha/hora de envío)" }, 400);

  const sendAtDate = new Date(sendAt);
  if (isNaN(sendAtDate.getTime()))
    return json({ ok: false, error: "Fecha de envío inválida" }, 400);
  if (sendAtDate <= new Date())
    return json({ ok: false, error: "La fecha de envío debe ser futura" }, 400);

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const destinatarios = to.split(",").map(e => e.trim()).filter(Boolean);
  for (const e of destinatarios) {
    if (!emailRe.test(e)) return json({ ok: false, error: `Email inválido: ${e}` }, 400);
  }

  const attachments = await parseAttachments(formData);

  const id = crypto.randomUUID();
  const scheduled = {
    id,
    to:          destinatarios,
    subject,
    message,
    attachments,
    sendAt:      sendAtDate.toISOString(),
    createdAt:   new Date().toISOString(),
    status:      "pending"
  };

  await env.CONTACTS.put(`scheduled:${id}`, JSON.stringify(scheduled));

  const index = await getScheduledIndex(env);
  index.push({ id, to: destinatarios.join(", "), subject, sendAt: scheduled.sendAt, status: "pending" });
  await env.CONTACTS.put("scheduled:list", JSON.stringify(index));

  return json({ ok: true, id, sendAt: scheduled.sendAt });
}

// ─────────────────────────────────────────────────────────────────
// LISTAR PROGRAMADOS
// ─────────────────────────────────────────────────────────────────
async function handleListScheduled(env) {
  const index = await getScheduledIndex(env);
  return json({ ok: true, scheduled: index.filter(e => e.status === "pending") });
}

// ─────────────────────────────────────────────────────────────────
// CANCELAR PROGRAMADO
// ─────────────────────────────────────────────────────────────────
async function handleCancelScheduled(id, env) {
  if (!id) return json({ ok: false, error: "ID requerido" }, 400);

  const index = await getScheduledIndex(env);
  const pos = index.findIndex(e => e.id === id);
  if (pos === -1) return json({ ok: false, error: "No encontrado" }, 404);

  index.splice(pos, 1);
  await env.CONTACTS.put("scheduled:list", JSON.stringify(index));
  await env.CONTACTS.delete(`scheduled:${id}`);

  return json({ ok: true });
}

// ─────────────────────────────────────────────────────────────────
// CRON: procesar envíos que ya vencieron
// ─────────────────────────────────────────────────────────────────
async function processScheduledEmails(env) {
  const index = await getScheduledIndex(env);
  const now   = new Date();
  const due   = index.filter(e => e.status === "pending" && new Date(e.sendAt) <= now);

  if (!due.length) return;

  for (const item of due) {
    try {
      const data = await env.CONTACTS.get(`scheduled:${item.id}`, "json");
      if (!data || data.status !== "pending") continue;

      await sendViaResend(data, env);
      saveContacts(env, Array.isArray(data.to) ? data.to : [data.to]).catch(() => {});

      data.status = "sent";
      data.sentAt = new Date().toISOString();
      // Conservar historial 7 días luego de enviado
      await env.CONTACTS.put(`scheduled:${item.id}`, JSON.stringify(data), { expirationTtl: 86400 * 7 });
      item.status = "sent";

    } catch (err) {
      console.error(`Error al enviar programado ${item.id}:`, err.message);
      item.status = "failed";
      try {
        const data = await env.CONTACTS.get(`scheduled:${item.id}`, "json");
        if (data) { data.status = "failed"; await env.CONTACTS.put(`scheduled:${item.id}`, JSON.stringify(data)); }
      } catch {}
    }
  }

  // Dejar solo los pendientes en el índice
  await env.CONTACTS.put("scheduled:list", JSON.stringify(index.filter(e => e.status === "pending")));
}

async function getScheduledIndex(env) {
  try {
    const val = await env.CONTACTS.get("scheduled:list", "json");
    return Array.isArray(val) ? val : [];
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────
// ENVÍO REAL via Resend
// ─────────────────────────────────────────────────────────────────
async function sendViaResend(data, env) {
  const FROM_NAME  = env.FROM_NAME  || "Mercado Limpio";
  const FROM_EMAIL = env.FROM_EMAIL || "proveedores@mercadolimpio.ar";
  const REPLY_TO   = env.REPLY_TO   || "distribuidoramercadolimpio@gmail.com";

  const attachments = data.attachments || [];
  const htmlBody = buildEmailHtml(data.message, data.subject, FROM_NAME, FROM_EMAIL, attachments);

  const body = {
    from:     `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to:       Array.isArray(data.to) ? data.to : [data.to],
    reply_to: REPLY_TO,
    subject:  data.subject,
    html:     htmlBody,
    ...(attachments.length ? { attachments } : {})
  };

  const res     = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body:    JSON.stringify(body)
  });
  const resData = await res.json();

  if (!res.ok) {
    console.error("Resend error:", JSON.stringify(resData));
    throw new Error(resData.message || resData.name || "Error de Resend");
  }
  return resData;
}

// ─────────────────────────────────────────────────────────────────
// CONTACTOS en KV
// ─────────────────────────────────────────────────────────────────
async function getContacts(env) {
  if (!env.CONTACTS) return [];
  try {
    const val = await env.CONTACTS.get("list", "json");
    return Array.isArray(val) ? val : [];
  } catch { return []; }
}

async function saveContacts(env, nuevos) {
  if (!env.CONTACTS) return;
  const existentes = await getContacts(env);
  let merged = [
    ...nuevos.map(e => e.trim().toLowerCase()),
    ...existentes.filter(e => !nuevos.map(x => x.toLowerCase()).includes(e))
  ];
  merged = [...new Set(merged)].slice(0, 200);
  await env.CONTACTS.put("list", JSON.stringify(merged));
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
async function parseAttachments(formData) {
  const archivos = formData.getAll("archivos");
  const result   = [];
  for (const f of archivos) {
    if (!(f instanceof File) || f.size === 0) continue;
    const buf = await f.arrayBuffer();
    result.push({ filename: f.name, content: arrayBufferToBase64(buf) });
  }
  return result;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}

function escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ─────────────────────────────────────────────────────────────────
// TEMPLATE HTML del email
// ─────────────────────────────────────────────────────────────────
function buildEmailHtml(message, subject, fromName, fromEmail, attachments = []) {
  const LOGO_URL  = "https://pablosantamaria26.github.io/proveedor-mailer/logo.jpeg";
  const date      = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" });
  const msgHtml   = escHtml(message).replace(/\n/g, "<br>");
  const hasAttach = attachments.length > 0;

  const attachList = hasAttach ? `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px">
      <tr>
        <td style="padding-bottom:10px;font-family:'Helvetica Neue',Arial,sans-serif;
                   font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;
                   color:#8a7a5a;border-bottom:1px solid #e8e0d0">
          Archivos adjuntos
        </td>
      </tr>
      ${attachments.map(a => `
      <tr>
        <td style="padding:10px 0;font-family:'Helvetica Neue',Arial,sans-serif;
                   font-size:13px;color:#4a5568;border-bottom:1px solid #f0ede8">
          &#128206;&nbsp;&nbsp;${escHtml(a.filename)}
        </td>
      </tr>`).join("")}
    </table>` : "";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0ede8;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0ede8;padding:48px 16px">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" border="0"
             style="max-width:620px;background-color:#ffffff;box-shadow:0 4px 32px rgba(15,27,53,0.10)">
        <tr><td height="6" style="background:linear-gradient(90deg,#0f1b35 0%,#1e3a6e 100%);font-size:0;line-height:0">&nbsp;</td></tr>
        <tr>
          <td align="center" style="padding:44px 52px 36px;background-color:#ffffff;border-bottom:3px solid #c9a558">
            <img src="${LOGO_URL}" alt="Mercado Limpio Distribuidora" width="210" style="display:block;border:0;max-width:210px">
          </td>
        </tr>
        <tr>
          <td style="padding:32px 52px 0;background-color:#ffffff">
            <p style="margin:0 0 6px;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:#8a7a5a;font-weight:600">${date}</p>
            <h2 style="margin:0;font-size:20px;font-weight:300;color:#0f1b35;letter-spacing:0.3px;line-height:1.35;border-bottom:1px solid #ede8e0;padding-bottom:24px">${escHtml(subject)}</h2>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 52px 40px;background-color:#ffffff">
            <p style="margin:0;font-size:15.5px;color:#2d3748;line-height:1.85;font-weight:300">${msgHtml}</p>
            ${attachList}
          </td>
        </tr>
        <tr><td height="1" style="background-color:#c9a558;font-size:0;line-height:0">&nbsp;</td></tr>
        <tr>
          <td style="padding:32px 52px;background-color:#faf8f5">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td>
                  <p style="margin:0 0 3px;font-size:13px;font-weight:700;color:#0f1b35;letter-spacing:0.3px">${escHtml(fromName)}</p>
                  <p style="margin:0 0 12px;font-size:12px;color:#8a7a5a;letter-spacing:0.5px">Distribuidora · Buenos Aires, Argentina</p>
                  <p style="margin:0;font-size:11px;color:#a09070">${escHtml(fromEmail)}</p>
                </td>
                <td align="right" valign="middle">
                  <div style="width:42px;height:42px;background-color:#0f1b35;border-radius:50%;display:inline-block;text-align:center;line-height:42px">
                    <span style="color:#c9a558;font-size:20px;font-weight:300">M</span>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 52px;background-color:#0f1b35">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td>
                  <p style="margin:0;font-size:10px;color:#5a7ab5;letter-spacing:1px;text-transform:uppercase">Mercado Limpio Distribuidora &reg;</p>
                  <p style="margin:4px 0 0;font-size:10px;color:#3d5a8a">Este email y sus adjuntos son confidenciales y de uso exclusivo del destinatario.</p>
                </td>
                <td align="right" valign="middle">
                  <p style="margin:0;font-size:10px;color:#3d5a8a">&#128274;&nbsp;Comunicación segura</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
