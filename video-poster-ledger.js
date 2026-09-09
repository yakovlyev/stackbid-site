const crypto = require('node:crypto');

function requestIdForDriveFile(fileId) {
  const hex = crypto.createHash('sha256').update(String(fileId)).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function lookupUpload(requestId, apiKey, fetchImpl = fetch) {
  const response = await fetchImpl(
    `https://api.upload-post.com/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`,
    {
      headers: { Authorization: `Apikey ${apiKey}` },
    },
  );
  if (response.status === 404) return null;
  if (response.ok) return response.json();
  throw new Error(`Unexpected Upload-Post status response: ${response.status}`);
}

function selectRecentDriveFiles(files, nowMs, lookbackMinutes, maxFiles) {
  const cutoff = nowMs - lookbackMinutes * 60_000;
  return files
    .filter((file) => {
      const created = Date.parse(file.createdTime);
      return Number.isFinite(created) && created >= cutoff && created <= nowMs;
    })
    .sort((a, b) => Date.parse(a.createdTime) - Date.parse(b.createdTime))
    .slice(0, maxFiles);
}

function submissionIdentity(fileId) {
  const requestId = requestIdForDriveFile(fileId);
  return {
    requestId,
    externalId: `stackbid:${requestId}`,
    idempotencyKey: requestId,
  };
}

async function findFirstUnsubmitted(files, lookup) {
  for (const file of files) {
    const identity = submissionIdentity(file.id);
    const existing = await lookup(identity.requestId);
    if (!existing) return { file, identity };
    if (!['pending', 'queued', 'processing', 'in_progress', 'completed'].includes(existing.status)) {
      throw new Error(`Existing Upload-Post request is not safe to retry: ${existing.status || 'unknown'}`);
    }
  }
  return null;
}

module.exports = {
  requestIdForDriveFile,
  lookupUpload,
  selectRecentDriveFiles,
  submissionIdentity,
  findFirstUnsubmitted,
};
