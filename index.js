require("dotenv").config();
const express = require("express");
const multer = require("multer");
const basicAuth = require("express-basic-auth");
const { Resend } = require("resend");
const fs = require("fs");
const path = require("path");

// ─── Config ────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.FROM_EMAIL   || "ventas@mercadolimpio.ar";
const FROM_NAME    = process.env.FROM_NAME    || "Mercado Limpio";
const REPLY_TO     = process.env.REPLY_TO     || "distribuidoramercadolimpio@gmail.com";
const APP_PASSWORD = process.env.APP_PASSWORD;          // si está seteado, pide contraseña
const MAX_MB       = parseInt(process.env.MAX_MB || "25");

if (!RESEND_KEY) {
  console.error("❌ Falta RESEND_API_KEY en .env");
  process.exit(1);
}

const resend = new Resend(RESEND_KEY);

// ─── Persistencia de contactos ─────────────────────────────────────────────────
const CONTACTS_FILE = path.join(__dirname, "data", "contacts.json");

function loadContacts() {
  try {
    return JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveContact(email) {
  const e = email.trim().toLowerCase();
  let contacts = loadContacts().filter(c => c !== e);
  contacts.unshift(e);
  contacts = contacts.slice(0, 200);
  fs.mkdirSync(path.dirname(CONTACTS_FILE), { recursive: true });
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
}

// ─── Express ────────────────────────────────────────────────────────────────────
const app = express();

// Protección con contraseña (opcional — solo si APP_PASSWORD está en .env)
if (APP_PASSWORD) {
  app.use(basicAuth({
    users: { admin: APP_PASSWORD },
    challenge: true,
    realm: "Mailer Proveedores"
  }));
  console.log("🔒 Acceso protegido con contraseña");
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ─── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "image/jpeg", "image/png", "image/gif", "image/webp",
      "text/plain", "text/csv",
      "application/zip",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
    }
  }
});

// ─── Rutas ─────────────────────────────────────────────────────────────────────

// Retorna lista de contactos (para autocomplete)
app.get("/contacts", (_req, res) => {
  res.json(loadContacts());
});

// Envío de email
app.post("/send", upload.array("archivos", 20), async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    if (!to || !subject || !message) {
      return res.status(400).json({ ok: false, error: "Faltan campos: to, subject, message" });
    }

    // Validación básica de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const destinatarios = to.split(",").map(e => e.trim()).filter(Boolean);
    for (const email of destinatarios) {
      if (!emailRegex.test(email)) {
        return res.status(400).json({ ok: false, error: `Email inválido: ${email}` });
      }
    }

    // Construir adjuntos
    const attachments = (req.files || []).map(file => ({
      filename: file.originalname,
      content: file.buffer
    }));

    // HTML del mensaje (respeta saltos de línea)
    const htmlBody = `
      <div style="font-family: Arial, sans-serif; font-size: 15px; color: #1e293b; line-height: 1.6; max-width: 680px;">
        ${message
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>")}
        <br><br>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
        <p style="font-size: 12px; color: #94a3b8; margin: 0;">
          ${FROM_NAME} · Buenos Aires, Argentina<br>
          Para responder a este email, usá Responder directamente.
        </p>
      </div>
    `;

    console.log(`📤 Enviando a: ${destinatarios.join(", ")} | Asunto: ${subject} | Adjuntos: ${attachments.length}`);

    const { data, error } = await resend.emails.send({
      from:      `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to:        destinatarios,
      reply_to:  REPLY_TO,
      subject,
      html:      htmlBody,
      attachments
    });

    if (error) {
      console.error("❌ Resend error:", error);
      return res.status(500).json({ ok: false, error: error.message || JSON.stringify(error) });
    }

    // Guardar cada destinatario en el historial
    destinatarios.forEach(saveContact);

    console.log(`✅ Enviado | id=${data?.id}`);
    res.json({ ok: true, id: data?.id });

  } catch (err) {
    console.error("❌ Error inesperado:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Inicio ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Mailer Proveedores corriendo en http://localhost:${PORT}`);
  console.log(`   From:     ${FROM_NAME} <${FROM_EMAIL}>`);
  console.log(`   Reply-To: ${REPLY_TO}`);
  if (APP_PASSWORD) console.log(`   Acceso:   protegido con contraseña\n`);
  else console.log(`   Acceso:   sin contraseña (agrega APP_PASSWORD al .env para proteger)\n`);
});
