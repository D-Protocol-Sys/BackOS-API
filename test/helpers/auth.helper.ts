import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import * as fs from 'fs';
import { OWNER_INVITATION_FILE } from './owner-invitation-file';
import { generateTotpCode } from './totp.helper';

/**
 * Completes the owner's ONE-TIME activation (invitation -> MFA enrollment -> MFA confirm, see
 * AuthController/AuthService: `POST /auth/invitation/consume` then `POST /auth/mfa/confirm`)
 * and returns a bearer token, exactly mirroring what a human would do manually on a fresh
 * database using the token/code prisma/seed.ts prints to the console.
 *
 * The raw token/code only ever exist in that console output (the DB stores nothing but bcrypt/
 * sha256 hashes of them - by design, see seed.ts) - so test/global-setup-e2e.ts captures the
 * seed run's stdout, regex-extracts them, and writes them to `.e2e-owner-invitation.json` for
 * this helper to read. If that file is missing, global setup did not run (or the seed script's
 * console.log format changed) - see the error message below for how to fix it.
 */
export async function bootstrapOwnerSession(app: INestApplication): Promise<{ accessToken: string }> {
    if (!fs.existsSync(OWNER_INVITATION_FILE)) {
        throw new Error(
            `${OWNER_INVITATION_FILE} not found - did test/global-setup-e2e.ts run? ` +
                'If prisma/seed.ts\'s console.log format for "Activation Link"/"OTP Code" changed, ' +
                'update the regex in global-setup-e2e.ts to match.',
        );
    }
    const { token, code, workEmail } = JSON.parse(fs.readFileSync(OWNER_INVITATION_FILE, 'utf-8'));
    const http = request(app.getHttpServer());

    // 1. Consume the invitation - returns the raw (plaintext) TOTP secret for manual entry
    // (`manualEntryKey`, see AuthService.consumeInvitation()'s return), which is exactly what
    // an authenticator app would show a human scanning the QR code.
    const consumeRes = await http.post('/api/auth/invitation/consume').send({ token, code }).expect(200);
    const totpSecret: string = consumeRes.body.manualEntryKey;

    // 2. Confirm MFA enrollment with a code computed from that secret - activates the account
    // (User.status -> ACTIVE, UserMfa.status -> ACTIVE) and already returns tokens directly.
    const confirmRes = await http
        .post('/api/auth/mfa/confirm')
        .send({ email: workEmail, totpCode: await generateTotpCode(totpSecret) })
        .expect(200);

    return { accessToken: confirmRes.body.accessToken };
}

/**
 * Full login (as opposed to bootstrapOwnerSession's one-time activation) for an account that is
 * ALREADY ACTIVE with MFA already ACTIVE - e.g. the demo account seeded by
 * prisma/seed-demo.ts, which is deliberately created pre-activated with a fixed, known secret
 * (see that file) so tests/demos never need the invitation dance at all.
 */
export async function loginWithKnownTotpSecret(
    app: INestApplication,
    loginIdentifier: string,
    totpSecret: string,
): Promise<{ accessToken: string }> {
    const response = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ loginIdentifier, totpCode: await generateTotpCode(totpSecret) })
        .expect(200);
    return { accessToken: response.body.accessToken };
}
