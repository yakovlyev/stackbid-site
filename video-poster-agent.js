/**
 * StackBid — Video Poster Agent
 *
 * Повна заміна Make-сценарію 5571686 (Google Drive → YouTube/Facebook/
 * Instagram/X). Причина відмови від Make: той самий висновок, що зробили
 * для Cartobi 06.09 — нестабільність самого Make (тихі збої API, ліміт
 * активних сценаріїв, неможливість толком продіагностувати провалений
 * крок) неприйнятна для контент-фабрики, яка має працювати без нагляду
 * на масштабі. Один прямий HTTP-виклик в Upload-Post замість зв'язки
 * Make + Cloudinary + нативні модулі під кожну площадку.
 *
 * Запускається за розкладом (див. render.yaml — інтервал 15 хвилин, як
 * було в Make). Кожен запуск:
 *   1. Через сервісний акаунт Google дивиться папку Google Drive
 *      "StackBid Videos" (Drive API v3 напряму через fetch + підписаний
 *      JWT — без пакету googleapis, той самий принцип "мінімум залежностей",
 *      що і скрізь у проєкті).
 *   2. Звіряє з таблицею posted_videos у Supabase — які файли вже
 *      публікувались, щоб не задвоювати.
 *   3. Для кожного нового файлу: скачує його, просить Claude згенерувати
 *      підписи під кожну площадку (як у Cartobi), публікує через
 *      Upload-Post (POST /api/upload, всі площадки одним викликом).
 *   4. Позначає файл як опублікований.
 *
 * Потрібні змінні оточення:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY
 *   UPLOAD_POST_KEY           (свій профіль "stackbid" — НЕ ключ/профіль
 *                              Cartobi, у кожного проєкту своя незалежна
 *                              інфраструктура)
 *   GOOGLE_DRIVE_FOLDER_ID    (ID папки "StackBid Videos")
 *   GA4_SERVICE_ACCOUNT_JSON  (перевикористовуємо той самий сервісний
 *                              акаунт, що і для GA4 — йому потрібне ще й
 *                              право на читання саме цієї папки Drive,
 *                              видане окремо через "Share" на саму папку,
 *                              доступ до Drive API окремо увімкнути в
 *                              тому ж проєкті Google Cloud)
 */

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const SUPABASE_URL = required('SUPABASE_URL');
const SUPABASE_KEY = required('SUPABASE_SERVICE_ROLE_KEY');

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.method === 'POST' ? 'return=representation' : undefined,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---- Google service-account auth (plain JWT, no googleapis dependency) ----
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleAccessToken(scope) {
  const creds = JSON.parse(required('GA4_SERVICE_ACCOUNT_JSON'));
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(
    JSON.stringify({
      iss: creds.client_email,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })
  );
  const unsigned = `${header}.${claim}`;
  const crypto = await import('node:crypto');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsigned)
    .sign(creds.private_key)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function listNewDriveVideos() {
  const folderId = required('GOOGLE_DRIVE_FOLDER_ID');
  const token = await getGoogleAccessToken('https://www.googleapis.com/auth/drive.readonly');
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    `'${folderId}' in parents and trashed=false and mimeType contains 'video/'`
  )}&fields=files(id,name,createdTime)&orderBy=createdTime`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive list failed: ${res.status} ${await res.text()}`);
  const { files } = await res.json();

  const posted = await supabaseFetch('posted_videos?select=drive_file_id');
  const postedIds = new Set((posted || []).map((p) => p.drive_file_id));
  return (files || []).filter((f) => !postedIds.has(f.id));
}

async function downloadDriveFile(fileId) {
  const token = await getGoogleAccessToken('https://www.googleapis.com/auth/drive.readonly');
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive download failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---- Caption generation (same pattern as Cartobi's generateSocialCaptions) ----
async function generateSocialCaptions(filename) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': required('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: `You write short social captions for StackBid (stackbid.app), a free AI construction cost estimator for US homeowners. Video filename for context: "${filename}". Write honest, direct captions — no fabricated stats, no hype. Always mention the free estimate. IMPORTANT about links: Instagram/TikTok never make a link in the caption text clickable — instead of a raw URL there, add a short "link in bio" style call to action. Facebook, X, LinkedIn, and the YouTube description DO auto-link a full https:// URL — always include the complete "https://stackbid.app" there. Output ONLY a JSON object, no markdown fences: {"instagram":"...","tiktok":"...","youtube_title":"...","youtube_description":"...","facebook":"...","threads":"...","x":"...","linkedin":"..."}. Instagram/TikTok/Threads captions ≤150 chars each (with a link-in-bio CTA, no raw URL). facebook ≤220 chars, must include full https://stackbid.app. x ≤200 chars, must include full https://stackbid.app. linkedin ≤400 chars, slightly more professional tone, must include full https://stackbid.app. youtube_title ≤80 chars, no link. youtube_description ≤200 chars, must include full https://stackbid.app.`,
      messages: [{ role: 'user', content: 'Generate the captions.' }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic caption call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const cleaned = raw.replace(/^```json\s*|```$/g, '').trim();
  return JSON.parse(cleaned);
}

// ---- Upload-Post (one call, all platforms) ----
async function postToSocialMedia(videoBuffer, filename, captions) {
  const form = new FormData();
  form.append('user', 'stackbid'); // Upload-Post profile — separate from Cartobi's "default"
  form.append('title', captions.youtube_title || filename);
  form.append('description', captions.youtube_description || '');
  form.append('platform[]', 'instagram');
  form.append('platform[]', 'facebook');
  form.append('platform[]', 'threads');
  form.append('platform[]', 'youtube');
  form.append('platform[]', 'x');
  form.append('platform[]', 'linkedin');
  form.append('instagram_title', captions.instagram || '');
  form.append('facebook_title', captions.facebook || '');
  form.append('threads_title', captions.threads || '');
  form.append('youtube_title', captions.youtube_title || '');
  form.append('x_title', captions.x || '');
  form.append('linkedin_title', captions.linkedin || '');
  form.append('video', new Blob([videoBuffer], { type: 'video/mp4' }), filename);

  const res = await fetch('https://api.upload-post.com/api/upload', {
    method: 'POST',
    headers: { Authorization: `Apikey ${required('UPLOAD_POST_KEY')}` },
    body: form,
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Upload-Post failed: ${res.status} ${JSON.stringify(result)}`);
  return result;
}

async function markPosted(file, result) {
  await supabaseFetch('posted_videos', {
    method: 'POST',
    body: JSON.stringify({
      drive_file_id: file.id,
      filename: file.name,
      upload_post_response: result,
    }),
  });
}

async function run() {
  console.log('Video Poster Agent — старт');
  const newVideos = await listNewDriveVideos();
  if (!newVideos.length) {
    console.log('Нових відео немає.');
    return;
  }
  for (const file of newVideos) {
    try {
      console.log(`Обробляю: ${file.name} (${file.id})`);
      const buffer = await downloadDriveFile(file.id);
      const captions = await generateSocialCaptions(file.name);
      const result = await postToSocialMedia(buffer, file.name, captions);
      await markPosted(file, result);
      console.log(`✓ Опубліковано: ${file.name}`);
    } catch (e) {
      console.error(`✗ Помилка на файлі ${file.name}:`, e.message);
      // Не переривати решту файлів через один збій
    }
  }
}

run().catch((err) => {
  console.error('Video Poster Agent впав:', err);
  process.exit(1);
});
