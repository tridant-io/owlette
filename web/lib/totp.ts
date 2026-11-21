import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import crypto from 'crypto';

authenticator.options = {
  step: 30, // Time step in seconds (standard is 30)
  window: 1, // Allow 1 time step before and after (prevents timing issues)
};

export function generateTOTPSecret(): string {
  return authenticator.generateSecret();
}

/** Data-URL QR code for authenticator-app enrollment. */
export async function generateQRCode(email: string, secret: string): Promise<string> {
  const appName = 'Owlette';
  const otpauth = authenticator.keyuri(email, appName, secret);

  try {
    const qrCodeDataURL = await QRCode.toDataURL(otpauth);
    return qrCodeDataURL;
  } catch (error) {
    console.error('Error generating QR code:', error);
    throw new Error('Failed to generate QR code');
  }
}

export function verifyTOTP(token: string, secret: string): boolean {
  try {
    return authenticator.verify({ token, secret });
  } catch (error) {
    console.error('Error verifying TOTP:', error);
    return false;
  }
}

/** The time step a valid code belongs to, or null, so a spent step can be refused. */
export function totpStep(token: string, secret: string): number | null {
  try {
    const checker = authenticator.clone({ epoch: Date.now() });
    const delta = checker.checkDelta(token, secret);
    if (delta === null) return null;
    const { epoch, step } = checker.allOptions();
    return Math.floor(epoch / 1000 / step) + delta;
  } catch (error) {
    console.error('Error verifying TOTP:', error);
    return null;
  }
}

export function hashBackupCode(code: string): string {
  return crypto
    .createHash('sha256')
    .update(code)
    .digest('hex');
}

export function verifyBackupCode(code: string, hash: string): boolean {
  const codeHash = hashBackupCode(code);
  return codeHash === hash;
}

/** AES-256-GCM. Output is base64 `salt:iv:authTag:ciphertext`. */
export function encryptSecret(secret: string, userKey: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(userKey, salt, 32);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(secret, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  return [
    salt.toString('base64'),
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted,
  ].join(':');
}

export function decryptSecret(encryptedSecret: string, userKey: string): string {
  try {
    // Legacy AES-CBC hex (pre-GCM migration) has no ':' separator.
    if (!encryptedSecret.includes(':')) {
      throw new Error('Legacy TOTP secret format — user must re-enroll MFA');
    }

    const parts = encryptedSecret.split(':');
    if (parts.length !== 4) {
      throw new Error('Invalid encrypted data format');
    }

    const [saltB64, ivB64, authTagB64, ciphertext] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const key = crypto.scryptSync(userKey, salt, 32);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Error decrypting secret:', error);
    throw new Error('Failed to decrypt TOTP secret');
  }
}
