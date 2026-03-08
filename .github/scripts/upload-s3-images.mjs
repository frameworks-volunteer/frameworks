#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, parse as parsePath, posix as pathPosix } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const MIME_EXTENSION_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);

    if (key === 'dry-run') {
      parsed.dryRun = true;
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`Missing value for argument --${key}`);
    }

    parsed[key] = value;
    i += 1;
  }

  return parsed;
}

function normalizeManifestPath(inputPath) {
  if (!inputPath) {
    fail('Missing required argument --manifest');
  }

  if (isAbsolute(inputPath)) {
    fail('Manifest path must be relative to the repository root');
  }

  const normalized = pathPosix.normalize(inputPath.replaceAll('\\', '/'));

  if (normalized.startsWith('../') || normalized.includes('/../')) {
    fail('Manifest path cannot contain parent-directory traversal');
  }

  if (!normalized.startsWith('.github/s3-image-uploads/')) {
    fail('Manifest path must live under .github/s3-image-uploads/');
  }

  if (!normalized.endsWith('.json')) {
    fail('Manifest file must use the .json extension');
  }

  return normalized;
}

function sanitizeBasename(input) {
  const withoutExtension = parsePath(input).name || input;
  const cleaned = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned || 'asset';
}

function normalizeTargetPath(targetPath, allowedTargetPrefix) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    fail('Every asset must include a non-empty target_path');
  }

  const normalized = pathPosix.normalize(targetPath.trim().replaceAll('\\', '/'));

  if (normalized.startsWith('/') || normalized.includes('..')) {
    fail(`Invalid target_path "${targetPath}": absolute and parent-traversal paths are not allowed`);
  }

  if (!normalized.startsWith(allowedTargetPrefix)) {
    fail(`Invalid target_path "${targetPath}": must start with "${allowedTargetPrefix}"`);
  }

  if (!/^images\/[a-z0-9][a-z0-9/_-]*$/.test(normalized)) {
    fail(`Invalid target_path "${targetPath}": only lowercase letters, numbers, hyphen, underscore, and '/' are allowed`);
  }

  return normalized.replace(/\/$/, '');
}

function assertAllowedHost(urlLike, allowedHosts) {
  let parsed;

  try {
    parsed = new URL(urlLike);
  } catch {
    fail(`Invalid URL: ${urlLike}`);
  }

  if (parsed.protocol !== 'https:') {
    fail(`Source URL must use HTTPS: ${urlLike}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const isAllowed = allowedHosts.some((allowedHost) => hostname === allowedHost || hostname.endsWith(`.${allowedHost}`));

  if (!isAllowed) {
    fail(`Source host is not allowlisted: ${hostname}`);
  }

  return parsed;
}

function detectMimeType(filePath) {
  const result = spawnSync('file', ['--mime-type', '-b', filePath], { encoding: 'utf8' });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ? ` (${result.stderr.trim()})` : '';
    fail(`Unable to detect MIME type for ${filePath}${stderr}`);
  }

  return result.stdout.trim().toLowerCase();
}

function runAwsUpload(localPath, bucket, key, mimeType) {
  const result = spawnSync(
    'aws',
    ['s3', 'cp', localPath, `s3://${bucket}/${key}`, '--only-show-errors', '--content-type', mimeType],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ? `\n${result.stderr.trim()}` : '';
    fail(`Failed to upload ${localPath} to s3://${bucket}/${key}${stderr}`);
  }
}

function appendSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const summary = lines.join('\n').concat('\n');
  return writeFile(summaryPath, summary, { flag: 'a' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const manifestPath = normalizeManifestPath(args.manifest);
  const bucket = args.bucket;
  const publicBaseUrl = (args['public-base-url'] || '').replace(/\/$/, '');
  const allowedTargetPrefix = (args['allowed-target-prefix'] || 'images/').replace(/\/$/, '') + '/';
  const maxBytes = Number.parseInt(args['max-bytes'] || '15728640', 10);
  const dryRun = Boolean(args.dryRun);

  if (!bucket) {
    fail('Missing required argument --bucket');
  }

  if (!publicBaseUrl) {
    fail('Missing required argument --public-base-url');
  }

  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    fail('--max-bytes must be a positive integer');
  }

  const allowedHosts = (args['allowed-hosts'] || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  if (allowedHosts.length === 0) {
    fail('Missing required argument --allowed-hosts (comma-separated list)');
  }

  let rawManifest;
  try {
    rawManifest = await readFile(manifestPath, 'utf8');
  } catch (error) {
    fail(`Unable to read manifest at ${manifestPath}: ${error.message}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(rawManifest);
  } catch (error) {
    fail(`Manifest ${manifestPath} is not valid JSON: ${error.message}`);
  }

  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.assets)) {
    fail('Manifest must be a JSON object with an "assets" array');
  }

  if (manifest.assets.length === 0) {
    fail('Manifest assets array cannot be empty');
  }

  if (manifest.assets.length > 50) {
    fail('Manifest cannot include more than 50 assets in one run');
  }

  const tempDir = await mkdtemp(`${tmpdir()}/frameworks-s3-upload-`);
  const uploadResults = [];

  try {
    for (const [index, asset] of manifest.assets.entries()) {
      if (!asset || typeof asset !== 'object') {
        fail(`Asset #${index + 1} must be a JSON object`);
      }

      const sourceUrl = asset.source_url;
      if (typeof sourceUrl !== 'string' || sourceUrl.trim() === '') {
        fail(`Asset #${index + 1} must include a non-empty source_url`);
      }

      const parsedSourceUrl = assertAllowedHost(sourceUrl.trim(), allowedHosts);
      const targetPath = normalizeTargetPath(asset.target_path, allowedTargetPrefix);

      const filenameFromUrl = decodeURIComponent(basename(parsedSourceUrl.pathname || '') || 'asset');
      const fileBaseName = sanitizeBasename(typeof asset.name === 'string' && asset.name.trim() !== '' ? asset.name : filenameFromUrl);

      const response = await fetch(parsedSourceUrl.toString(), { redirect: 'follow' });

      if (!response.ok) {
        fail(`Failed to download ${parsedSourceUrl}: HTTP ${response.status}`);
      }

      assertAllowedHost(response.url, allowedHosts);

      const reportedSize = response.headers.get('content-length');
      if (reportedSize && Number.parseInt(reportedSize, 10) > maxBytes) {
        fail(`Asset too large (${reportedSize} bytes): ${parsedSourceUrl}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const fileBuffer = Buffer.from(arrayBuffer);

      if (fileBuffer.byteLength > maxBytes) {
        fail(`Asset exceeds --max-bytes (${maxBytes}): ${parsedSourceUrl}`);
      }

      const tempFilePath = `${tempDir}/asset-${index + 1}`;
      await writeFile(tempFilePath, fileBuffer);

      const mimeType = detectMimeType(tempFilePath);
      const extension = MIME_EXTENSION_MAP[mimeType];

      if (!extension) {
        fail(`Unsupported MIME type "${mimeType}" for ${parsedSourceUrl}`);
      }

      const shortHash = createHash('sha256').update(fileBuffer).digest('hex').slice(0, 12);
      const key = `${targetPath}/${fileBaseName}-${shortHash}.${extension}`;
      const publicUrl = `${publicBaseUrl}/${key}`;

      if (!dryRun) {
        runAwsUpload(tempFilePath, bucket, key, mimeType);
      }

      uploadResults.push({
        source_url: parsedSourceUrl.toString(),
        key,
        mime_type: mimeType,
        bytes: fileBuffer.byteLength,
        public_url: publicUrl,
      });
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const summaryLines = [
    '## S3 image upload results',
    '',
    `- Mode: ${dryRun ? 'dry-run (no upload)' : 'upload'}`,
    `- Manifest: \`${manifestPath}\``,
    `- Files processed: ${uploadResults.length}`,
    '',
    '| Source | S3 key | Public URL |',
    '| --- | --- | --- |',
    ...uploadResults.map((result) => `| ${result.source_url} | \`${result.key}\` | ${result.public_url} |`),
  ];

  await appendSummary(summaryLines);
  process.stdout.write(`${JSON.stringify({ dry_run: dryRun, uploads: uploadResults }, null, 2)}\n`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
