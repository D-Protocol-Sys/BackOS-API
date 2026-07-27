import { registerAs } from '@nestjs/config';

export default registerAs('otp', () => ({

    saltRounds: parseInt(
        process.env.BCRYPT_SALT_ROUNDS ?? '12',
        10,
    ),

    expiresInMinutes: parseInt(
        process.env.OTP_EXPIRES_IN_MINUTES ?? '10',
        10,
    ),

    maxAttempts: parseInt(
        process.env.OTP_MAX_ATTEMPTS ?? '5',
        10,
    ),
    
}));