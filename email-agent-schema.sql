-- email-agent-schema.sql
-- Таблица для отслеживания уже обработанных писем, чтобы агент не дублировал
-- черновики при повторном запуске (крон раз в час может пересечься со старыми письмами).

CREATE TABLE IF NOT EXISTS email_agent_log (
  message_id     text PRIMARY KEY,
  from_address   text,
  subject        text,
  category       text,       -- homeowner_question | contractor_inquiry | press_partnership | bug_or_complaint | spam | error
  confidence     text,       -- high | medium | low
  draft_created  boolean DEFAULT false,
  processed_at   timestamptz DEFAULT now()
);

-- Индекс на processed_at пригодится позже для отчётов "сколько писем и какой категории за неделю"
CREATE INDEX IF NOT EXISTS idx_email_agent_log_processed_at ON email_agent_log (processed_at DESC);
