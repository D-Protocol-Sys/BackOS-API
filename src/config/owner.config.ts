import { registerAs } from '@nestjs/config';

/**
 * Bootstrap Owner Identity Configuration Namespace ('owner')
 * * Defines default credentials and information used during database seeding
 * to instantiate the root System Owner (Genesis User).
 * Accessible via `ConfigService.get('owner.property')`.
 */
export default registerAs('owner', () => ({
    /**
     * Primary work email address assigned to the initial system owner account.
     */
    workEmail: process.env.OWNER_WORKEMAIL,

    /**
     * Personal email of the system owner account.
     */
    personalEmail: process.env.OWNER_PERSONALEMAIL,

    /**
     * First name of the system owner account.
     */
    firstName: process.env.OWNER_FIRSTNAME,

    /**
     * Last name of the system owner account.
     */
    lastName: process.env.OWNER_LASTNAME,

    /**
     * Last name of the system owner account.
     */
    username: process.env.OWNER_USERNAME,
}));
