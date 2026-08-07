import { registerAs } from '@nestjs/config';

export default registerAs('status', () => ({

    encryptionKey: process.env.ENCRYPTION_KEY,

    deactivationGracePeriodDays: process.env.DEACTIVATION_GRACE_PERIOD_DAYS,

}));