import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

export function encrypt(plainText: string, encryptionKeyHex: string): string {
    const key = Buffer.from(encryptionKeyHex, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decrypt(payload: string, encryptionKeyHex: string): string {
    const key = Buffer.from(encryptionKeyHex, 'hex');
    const [ivB64, authTagB64, dataB64] = payload.split(':');
    if (!ivB64 || !authTagB64 || !dataB64) {
        throw new Error('Format de donnée chiffrée invalide.');
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
    ]);
    return decrypted.toString('utf8');
}