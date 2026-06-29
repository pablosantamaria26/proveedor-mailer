-- Ejecutar en Supabase → SQL Editor
-- https://supabase.com/dashboard/project/uqbeeluqmgzbmlfsxtge/sql

CREATE TABLE IF NOT EXISTS emails_enviados (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz DEFAULT now(),
  destinatarios text[]      NOT NULL,
  asunto        text        NOT NULL,
  mensaje_texto text        NOT NULL,
  cuerpo_html   text,
  adjuntos_meta jsonb       DEFAULT '[]'::jsonb,  -- [{filename, size}] — para listado rápido
  adjuntos_data jsonb       DEFAULT '[]'::jsonb,  -- [{filename, content (base64)}] — para descarga
  resend_id     text,
  tipo          text        NOT NULL DEFAULT 'inmediato',
  enviado_at    timestamptz DEFAULT now()
);

-- Deshabilitar RLS (herramienta interna, no se expone al público)
ALTER TABLE emails_enviados DISABLE ROW LEVEL SECURITY;

-- Índice para búsquedas rápidas por fecha
CREATE INDEX IF NOT EXISTS idx_emails_enviados_at ON emails_enviados (enviado_at DESC);
