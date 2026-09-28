import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Encrypts secrets at rest with AES-256-GCM; the key lives only in the server's environment. */
export const createTokenBox = (keyBase64: string) => {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32)
    throw new Error('the token encryption key must be 32 bytes, base64-encoded');
  return {
    seal: (plain: string): string => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return `v1.${Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64')}`;
    },
    open: (box: string): string => {
      const raw = Buffer.from(box.replace(/^v1\./, ''), 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
};

export type TokenBox = ReturnType<typeof createTokenBox>;
