require("dotenv").config();
const express = require("express");
const multer  = require("multer");
const cors    = require("cors");
const { Resend } = require("resend");
const fs   = require("fs");
const path = require("path");

// ── Config ──────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT          || 3000;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL    = process.env.FROM_EMAIL    || "ventas@mercadolimpio.ar";
const FROM_NAME     = process.env.FROM_NAME     || "Mercado Limpio";
const REPLY_TO      = process.env.REPLY_TO      || "distribuidoramercadolimpio@gmail.com";
const MAILER_SECRET = process.env.MAILER_SECRET || "";

if (!RESEND_KEY) { console.error("❌ Falta RESEND_API_KEY"); process.exit(1); }

const resend = new Resend(RESEND_KEY);

// ── Persistencia de contactos (archivo JSON local) ──────────────────────────
const CONTACTS_FILE = path.join(__dirname, "data", "contacts.json");

function loadContacts() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8")); }
  catch { return []; }
}

function saveContact(email) {
  const e = email.trim().toLowerCase();
  let list = loadContacts().filter(c => c !== e);
  list.unshift(e);
  list = list.slice(0, 200);
  fs.mkdirSync(path.dirname(CONTACTS_FILE), { recursive: true });
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(list, null, 2));
}

// ── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ── Multer (memoria, sin tocar disco) ───────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// ── Autenticación simple por header ─────────────────────────────────────────
function auth(req, res, next) {
  if (!MAILER_SECRET) return next();
  if (req.headers["x-mailer-secret"] !== MAILER_SECRET)
    return res.status(401).json({ ok: false, error: "No autorizado" });
  next();
}

// ── GET /contacts ────────────────────────────────────────────────────────────
app.get("/contacts", auth, (_req, res) => {
  res.json(loadContacts());
});

// ── POST /send ───────────────────────────────────────────────────────────────
app.post("/send", auth, upload.array("archivos", 20), async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    if (!to || !subject || !message)
      return res.status(400).json({ ok: false, error: "Faltan campos: to, subject, message" });

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const destinatarios = to.split(",").map(e => e.trim()).filter(Boolean);
    for (const e of destinatarios)
      if (!emailRe.test(e))
        return res.status(400).json({ ok: false, error: `Email inválido: ${e}` });

    const attachments = (req.files || []).map(f => ({
      filename: f.originalname,
      content:  f.buffer
    }));

    const html = `
      <div style="font-family:Arial,sans-serif;font-size:15px;color:#1e293b;line-height:1.6;max-width:680px">
        ${message
          .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
          .replace(/\n/g,"<br>")}
        <br><br>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
        <p style="font-size:12px;color:#94a3b8;margin:0">
          ${FROM_NAME} · Buenos Aires, Argentina
        </p>
      </div>`;

    console.log(`📤 → ${destinatarios.join(", ")} | ${subject} | adjuntos: ${attachments.length}`);

    const { data, error } = await resend.emails.send({
      from:       `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to:         destinatarios,
      reply_to:   REPLY_TO,
      subject,
      html,
      attachments
    });

    if (error) {
      console.error("❌ Resend:", error);
      return res.status(500).json({ ok: false, error: error.message || JSON.stringify(error) });
    }

    destinatarios.forEach(e => { try { saveContact(e); } catch {} });
    console.log(`✅ Enviado | id=${data?.id}`);
    res.json({ ok: true, id: data?.id });

  } catch (err) {
    console.error("❌", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Mailer corriendo en http://localhost:${PORT}`);
  console.log(`   From:     ${FROM_NAME} <${FROM_EMAIL}>`);
  console.log(`   Reply-To: ${REPLY_TO}`);
  console.log(`   Secret:   ${MAILER_SECRET ? "configurado ✓" : "sin protección (agrega MAILER_SECRET)"}\n`);
});
