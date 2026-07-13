-- Email Campaign Agent — дополнения к таблице users
-- Применить через SQL Editor в Supabase (тот же проект StackBid)

alter table users add column if not exists unsubscribed boolean default false;
alter table users add column if not exists nurture1_sent boolean default false;
alter table users add column if not exists nurture2_sent boolean default false;
alter table users add column if not exists nurture3_sent boolean default false;

-- unsubscribed — общий флаг, проверяется и nurture-цепочкой, и (на будущее)
-- любой другой массовой рассылкой, которая появится позже.
-- nurture1/2/3_sent — по аналогии с уже существующим feedback_sent,
-- отмечает, какие письма цепочки уже ушли этому пользователю.
