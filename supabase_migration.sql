-- Ejecutar en Supabase SQL Editor para agregar columnas de seguimiento
ALTER TABLE emails_enviados
  ADD COLUMN IF NOT EXISTS respondido     boolean    DEFAULT false,
  ADD COLUMN IF NOT EXISTS respondido_at  timestamptz,
  ADD COLUMN IF NOT EXISTS tiene_adjuntos boolean    DEFAULT false,
  ADD COLUMN IF NOT EXISTS estado_entrega text       DEFAULT 'enviado';

-- Backfill tiene_adjuntos para emails ya guardados
UPDATE emails_enviados SET tiene_adjuntos = (adjuntos_meta != '[]'::jsonb) WHERE tiene_adjuntos IS NULL;

CREATE INDEX IF NOT EXISTS idx_emails_respondido  ON emails_enviados(respondido);
CREATE INDEX IF NOT EXISTS idx_emails_tiene_adj   ON emails_enviados(tiene_adjuntos);
CREATE INDEX IF NOT EXISTS idx_emails_estado      ON emails_enviados(estado_entrega);
