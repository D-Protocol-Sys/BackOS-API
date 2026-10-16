// Mirrors src/common/utils/totp.service.ts exactly (same `otplib` functional API: `generate`
// is the counterpart to that file's `verify`) so a code produced here is guaranteed valid
// against a secret the app itself generated - no separate TOTP implementation to drift out of
// sync with the app's.
import { generate } from 'otplib';

export function generateTotpCode(secret: string): Promise<string> | string {
    return generate({ secret });
}
