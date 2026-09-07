-- Таблиця для video-poster-agent.js — відстежує, які файли з папки
-- Google Drive "StackBid Videos" вже опубліковані через Upload-Post, щоб
-- не задвоювати публікацію при кожному запуску крона.
create table if not exists posted_videos (
  id bigint generated always as identity primary key,
  drive_file_id text not null unique,
  filename text,
  upload_post_response jsonb,
  posted_at timestamptz not null default now()
);
