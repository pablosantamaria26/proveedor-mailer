// ================================================================
// Mailer Proveedores — Cloudflare Worker
// ================================================================

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Mailer-Secret",
};

export default {
  async fetch(request, env) {

    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // ── Autenticación ──────────────────────────────────────────────
    if (env.MAILER_SECRET) {
      const sent = request.headers.get("X-Mailer-Secret") || "";
      if (sent !== env.MAILER_SECRET) {
        return json({ ok: false, error: "No autorizado" }, 401);
      }
    }

    // ── GET /contacts ──────────────────────────────────────────────
    if (request.method === "GET" && url.pathname === "/contacts") {
      const list = await getContacts(env);
      return json(list);
    }

    // ── POST /send ─────────────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/send") {
      return handleSend(request, env);
    }

    return new Response("Not found", { status: 404 });
  }
};

// ── Envío de email ─────────────────────────────────────────────────────────
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

  // Adjuntos → base64 (Resend los recibe así)
  const archivos = formData.getAll("archivos");
  const attachments = [];
  for (const f of archivos) {
    if (!(f instanceof File) || f.size === 0) continue;
    const buf = await f.arrayBuffer();
    attachments.push({
      filename: f.name,
      content:  arrayBufferToBase64(buf)
    });
  }

  const FROM_NAME  = env.FROM_NAME  || "Mercado Limpio";
  const FROM_EMAIL = env.FROM_EMAIL || "ventas@mercadolimpio.ar";
  const REPLY_TO   = env.REPLY_TO   || "distribuidoramercadolimpio@gmail.com";

  const htmlBody = `
    <div style="font-family:Arial,sans-serif;font-size:15px;color:#1e293b;line-height:1.6;max-width:680px">
      ${escHtml(message).replace(/\n/g, "<br>")}
      <br><br>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
      <p style="font-size:12px;color:#94a3b8;margin:0">${escHtml(FROM_NAME)} · Buenos Aires, Argentina</p>
    </div>`;

  const body = {
    from:        `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to:          destinatarios,
    reply_to:    REPLY_TO,
    subject,
    html:        htmlBody,
    ...(attachments.length ? { attachments } : {})
  };

  const resendRes = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type":  "application/json"
    },
    body: JSON.stringify(body)
  });

  const resendData = await resendRes.json();

  if (!resendRes.ok) {
    console.error("Resend error:", JSON.stringify(resendData));
    return json({ ok: false, error: resendData.message || resendData.name || "Error de Resend" }, 500);
  }

  // Guardar contactos (sin bloquear la respuesta)
  saveContacts(env, destinatarios).catch(() => {});

  return json({ ok: true, id: resendData.id });
}

// ── Contactos en KV ────────────────────────────────────────────────────────
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

// ── Helpers ────────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}

function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
