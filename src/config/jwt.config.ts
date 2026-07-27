import { registerAs } from '@nestjs/config';

export default registerAs('jwt', () => ({

    secret: process.env.JWT_SECRET!,

    expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',

    refreshTokenExpiresInDays: parseInt(
        process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS ?? '7',
        10,
    ),
    
}));