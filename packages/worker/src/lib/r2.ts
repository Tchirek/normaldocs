import { AwsClient } from 'aws4fetch';
import type { Env } from '../types';

function aws(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto'
  });
}

function objectUrl(env: Env, key: string, expires?: number): string {
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${encodeURIComponent(key).replace(/%2F/g, '/')}`);
  if (expires) url.searchParams.set('X-Amz-Expires', String(expires));
  return url.toString();
}

export async function presignedPut(env: Env, key: string, contentType: string, expires = 600): Promise<string> {
  const signed = await aws(env).sign(objectUrl(env, key, expires), {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    aws: { signQuery: true }
  });
  return signed.url;
}

export async function presignedGet(env: Env, key: string, expires = 600): Promise<string> {
  const signed = await aws(env).sign(objectUrl(env, key, expires), {
    method: 'GET',
    aws: { signQuery: true }
  });
  return signed.url;
}
